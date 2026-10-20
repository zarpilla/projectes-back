'use strict';

/**
 * Notices writes made outside this process (issues/307): the other backend
 * slot during a deploy's overlap, a manual SQL repair, a restore.
 *
 * MySQL keeps, for each InnoDB table, the time of the last commit that changed
 * it (information_schema.TABLES.UPDATE_TIME, read live with
 * information_schema_stats_expiry = 0). Before a cached result is served, the
 * stamps of the tables the cache depends on are read again if the last reading
 * is older than `intervalMs`; a table whose stamp moved is reported to the
 * change tracker as changed, exactly like a write seen by the hook.
 *
 * Measured on MySQL 8.4 (issues/307): the stamp moves at COMMIT, not while the
 * transaction is open; stays on rollback, on updates that change nothing and
 * on updates that match no row; moves on the tables a foreign key cascades
 * to; and goes back to NULL after TRUNCATE, a rebuilding ALTER, a MySQL
 * restart, or when the table leaves the dictionary cache. So:
 *   - any change of value, NULL included, is a change;
 *   - the stamp has 1 s precision: a write in the same second as the reading
 *     could hide behind an unchanged value, so a stamp that was recent when
 *     read is reported once more on the first reading 2 s after it;
 *   - a table also carries its CREATE_TIME, so a dropped and re-created table
 *     counts as changed;
 *   - a MySQL restart (its start time moved) is a change of every table.
 *
 * A cached result is trusted by this layer only if every table it depends on
 * had been read at least once before its load began (`coveredSince`):
 * otherwise a write between the load and the first reading would be taken as
 * the starting point.
 */

const DEFAULT_INTERVAL_MS = 2000;

class TableStamps {
  /**
   * @param {object} options
   * @param {import('./change-tracker').ChangeTracker} options.tracker
   * @param {(tables: string[]) => Promise<{ now: number, started: number|null, rows: { table: string, updated: number|null, created: number|null }[] }>} options.read
   *   reads the stamps of the tables (see readStamps)
   * @param {number} [options.intervalMs]
   * @param {() => number} [options.clock]
   */
  constructor({ tracker, read, intervalMs = DEFAULT_INTERVAL_MS, clock = Date.now }) {
    this.tracker = tracker;
    this.read = read;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.watched = new Set();
    this.seen = new Map(); // table -> { value, updated, recheckAt, sinceSeq }
    this.seq = 0; // readings completed
    this.lastStartedAt = -Infinity;
    this.inFlight = null;
    this.unread = false;
    this.lastError = null;
    this.serverStarted = null;
    this.stats = { readings: 0, failures: 0, changes: 0, rechecks: 0, restarts: 0 };
  }

  /** Readings completed so far: a load records it when it begins. */
  completed() {
    return this.seq;
  }

  /** Starts watching these tables; new ones are read at the next `fresh()`. */
  watch(tables) {
    for (const t of tables) {
      if (this.watched.has(t)) continue;
      this.watched.add(t);
      this.unread = true;
    }
  }

  /** True if every table had been read by reading number `seq`. */
  coveredSince(tables, seq) {
    for (const t of tables) {
      const s = this.seen.get(t);
      if (!s || s.sinceSeq > seq) return false;
    }
    return true;
  }

  /**
   * Resolves once a reading that began within the last `intervalMs` has
   * completed (starting one if needed). Rejects if that reading failed.
   */
  fresh() {
    if (this.inFlight) return this.inFlight;
    const recent = this.clock() - this.lastStartedAt < this.intervalMs;
    if (recent && this.seq > 0 && !this.lastError && !this.unread) return Promise.resolve();
    return this.check();
  }

  /** Reads the stamps now (or joins the reading in progress). */
  check() {
    if (this.inFlight) return this.inFlight;
    this.lastStartedAt = this.clock();
    this.unread = false;
    const tables = [...this.watched];
    const reading = (async () => {
      try {
        const answer = await this.read(tables);
        this.apply(tables, answer);
        this.lastError = null;
      } catch (error) {
        this.stats.failures++;
        this.lastError = error;
        this.unread = true;
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = reading;
    return reading;
  }

  apply(tables, { now, started, rows }) {
    this.stats.readings++;
    const seq = this.seq + 1;

    if (started !== null && started !== undefined) {
      if (this.serverStarted !== null && Math.abs(started - this.serverStarted) > 5) {
        // MySQL restarted: every stamp went back to NULL
        this.stats.restarts++;
        this.seen.clear();
        this.tracker.everythingChanged('mysql restart');
      }
      this.serverStarted = started;
    }

    const byTable = new Map(rows.map((r) => [String(r.table).toLowerCase(), r]));
    const changed = [];
    for (const t of tables) {
      const row = byTable.get(t);
      const updated = row && row.updated !== null && row.updated !== undefined ? Number(row.updated) : null;
      const created = row && row.created !== null && row.created !== undefined ? Number(row.created) : null;
      const value = row ? `${updated}|${created}` : 'missing';
      // a recent stamp may hide a later write in the same second
      const recheckAt = updated !== null && updated >= now - 1 ? updated + 2 : null;
      const before = this.seen.get(t);

      if (!before) {
        this.seen.set(t, { value, updated, recheckAt, sinceSeq: seq });
        continue;
      }
      if (before.value !== value) {
        changed.push(t);
        this.seen.set(t, { value, updated, recheckAt, sinceSeq: before.sinceSeq });
        continue;
      }
      if (before.recheckAt !== null && now >= before.recheckAt) {
        this.stats.rechecks++;
        changed.push(t);
        before.recheckAt = null;
      }
    }
    if (changed.length) {
      this.stats.changes += changed.length;
      this.tracker.externalChange(changed);
    }
    this.seq = seq;
  }
}

/**
 * Reads the stamps with knex. One connection is pinned (a transaction) so the
 * session setting applies to the query that follows it.
 * @param {import('knex').Knex} knex
 */
function stampReader(knex) {
  return async (tables) =>
    knex.transaction(async (trx) => {
      await trx.raw('SET SESSION information_schema_stats_expiry = 0');
      const [[clock]] = await trx.raw('SELECT UNIX_TIMESTAMP() AS now');
      let started = null;
      try {
        // when MySQL started, to notice a restart; optional
        const [[up]] = await trx.raw(
          "SELECT UNIX_TIMESTAMP() - VARIABLE_VALUE AS started FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'",
        );
        if (up && up.started !== null && up.started !== undefined) started = Math.round(Number(up.started));
      } catch {
        started = null;
      }
      let rows = [];
      if (tables.length) {
        const [found] = await trx.raw(
          `SELECT TABLE_NAME AS \`table\`, UNIX_TIMESTAMP(UPDATE_TIME) AS updated, UNIX_TIMESTAMP(CREATE_TIME) AS created
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`,
          tables,
        );
        rows = found;
      }
      return { now: Number(clock.now), started, rows };
    });
}

module.exports = { TableStamps, stampReader, DEFAULT_INTERVAL_MS };
