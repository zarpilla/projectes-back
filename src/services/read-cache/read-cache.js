'use strict';

/**
 * The backend's read cache (issues/307).
 *
 * `get(key, loader, { tables })` answers from memory when it can and runs the
 * loader when it can't. What a kept result depends on is decided by what its
 * load did, not only by what the caller declares: every table the loader read
 * (seen by the hook on the MySQL connections) is added to `tables`. The result
 * is served again only while none of those tables changed since its load
 * began (change-tracker.js), and, for writes from outside this process, while
 * MySQL's stamps of those tables haven't moved (table-stamps.js).
 *
 * What is never kept:
 *   - a result whose tables changed while it was loading (it is still
 *     returned to its caller, like any uncached read);
 *   - a load that wrote something, read no known table, or read a table the
 *     tracker doesn't know;
 *   - anything read inside a transaction (the cache is skipped there: the
 *     transaction may see its own uncommitted writes or an older snapshot);
 *   - a result that can't be copied, or is larger than a quarter of the cap.
 * When change detection itself fails, nothing is served from memory.
 *
 * Callers never share objects with the cache: the kept value is a private copy,
 * and each answer is a fresh copy of it.
 *
 * Requests that miss together share one load, but only if nothing they depend
 * on changed while it ran; otherwise each loads for itself.
 *
 * Memory is capped (bytes of the JSON form, least recently used first out),
 * and every entry also expires after `ttlMs` as a last safety net.
 *
 * `verifyRate` (0..1): that share of hits is loaded again and compared with
 * what was kept. A difference that no recorded change explains is logged as an
 * error and the entry is dropped: proof that a write went unnoticed.
 */

const MB = 1024 * 1024;

const copy = (value) => structuredClone(value);

class ReadCache {
  constructor({
    tracker,
    stamps = null,
    maxBytes = 64 * MB,
    ttlMs = 10 * 60 * 1000,
    verifyRate = 0,
    clock = Date.now,
    random = Math.random,
    inTransaction = () => false,
    log = null,
  }) {
    this.tracker = tracker;
    this.stamps = stamps;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.verifyRate = verifyRate;
    this.clock = clock;
    this.random = random;
    this.inTransaction = inTransaction;
    this.log = log;
    this.enabled = false;
    this.entries = new Map(); // key -> entry, least recently used first
    this.byTable = new Map(); // table -> keys
    this.loading = new Map(); // key -> shared load
    this.bytes = 0;
    this.counts = {
      hits: 0,
      misses: 0,
      shared: 0,
      stored: 0,
      bypassed: 0,
      dropped: 0,
      evicted: 0,
      verified: 0,
      mismatches: 0,
      stampFailures: 0,
      notStored: {},
      invalid: {},
    };
    this.unsubscribe = tracker.onChange((tables) => this.dropChanged(tables));
  }

  /** True when results may be served from memory. */
  isOn() {
    return this.enabled && !this.tracker.failure;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    this.clear('disabled');
  }

  /**
   * @template T
   * @param {string} key everything the result depends on besides the tables
   * @param {() => Promise<T>} loader
   * @param {{ tables?: string[], ttlMs?: number, keep?: (value: T) => boolean }} [options]
   *   tables: what the result depends on beyond what the loader reads
   *   keep: false for a result that must not be kept (an error page...)
   * @returns {Promise<T>}
   */
  async get(key, loader, options = {}) {
    if (!this.isOn() || this.inTransaction()) {
      this.counts.bypassed++;
      return loader();
    }

    const entry = this.entries.get(key);
    if (entry) {
      let invalid;
      try {
        invalid = await this.whyInvalid(entry);
      } catch (error) {
        return this.withoutStamps(error, loader);
      }
      if (invalid) this.counts.invalid[invalid] = (this.counts.invalid[invalid] || 0) + 1;
      if (!invalid && this.entries.get(key) === entry) {
        this.touch(key, entry);
        if (this.verifyRate > 0 && this.random() < this.verifyRate) return this.verify(key, entry, loader);
        this.counts.hits++;
        this.tracker.noteRead(entry.tables);
        return copy(entry.value);
      }
      if (this.entries.get(key) === entry) this.remove(key, null);
    }

    const shared = this.loading.get(key);
    if (shared) {
      const result = await shared.catch(() => null);
      if (result && result.stored && !this.tracker.changedSince(result.tables, result.started)) {
        this.counts.shared++;
        this.tracker.noteRead(result.tables);
        // from the kept copy: the first caller may already be changing its own
        return copy(result.kept);
      }
    }

    this.counts.misses++;
    return this.load(key, loader, options);
  }

  /** Why a kept entry can't be served, or null when it can. */
  async whyInvalid(entry) {
    if (this.clock() >= entry.expiresAt) return 'expired';
    if (this.tracker.changedSince(entry.tables, entry.started)) return 'changed';
    if (this.stamps) {
      await this.tracker.capture.exit(() => this.stamps.fresh());
      if (!this.stamps.coveredSince(entry.tables, entry.stampSeq)) return 'stamps not read before the load';
      if (this.tracker.changedSince(entry.tables, entry.started)) return 'changed (stamps)';
    }
    return null;
  }

  /** The stamps can't be read: answer from the database, keep nothing. */
  withoutStamps(error, loader) {
    this.counts.stampFailures++;
    this.counts.bypassed++;
    this.warn(
      `[read-cache] can't read the table stamps, answering from the database: ${error && error.message}`,
    );
    return loader();
  }

  async load(key, loader, options) {
    const started = this.tracker.now();
    const stampSeq = this.stamps ? this.stamps.completed() : 0;

    const run = (async () => {
      const { result, store } = await this.tracker.captureReads(loader);
      const tables = [
        ...new Set([...(options.tables || []).map((t) => String(t).toLowerCase()), ...store.tables]),
      ];
      const reason = this.whyNotKept(result, store, tables, started, options);
      // what this load read is also read by whoever called it (an outer load
      // sees for itself a change during this one: it has the same tables and
      // began earlier); only an unsafe load makes the outer one unsafe too
      this.tracker.noteRead(tables, store.uncacheable);
      if (reason) {
        this.counts.notStored[reason] = (this.counts.notStored[reason] || 0) + 1;
        return { value: result, stored: false, tables, started };
      }
      let kept;
      let bytes;
      try {
        kept = copy(result);
        bytes = Buffer.byteLength(JSON.stringify(result) || '');
      } catch {
        this.counts.notStored['not copyable'] = (this.counts.notStored['not copyable'] || 0) + 1;
        return { value: result, stored: false, tables, started };
      }
      if (bytes > this.maxBytes / 4) {
        this.counts.notStored['too big'] = (this.counts.notStored['too big'] || 0) + 1;
        return { value: result, stored: false, tables, started };
      }
      // the tables may have changed while the result was being copied: no,
      // copying is synchronous; but a disable() or clear() may have happened
      if (!this.isOn() || this.tracker.changedSince(tables, started)) {
        return { value: result, stored: false, tables, started };
      }
      this.store(key, {
        value: kept,
        tables,
        started,
        stampSeq,
        bytes,
        expiresAt: this.clock() + (options.ttlMs || this.ttlMs),
      });
      if (this.stamps) this.stamps.watch(tables);
      return { value: result, kept, stored: true, tables, started };
    })();

    this.loading.set(key, run);
    try {
      const result = await run;
      // the cache keeps its own copy, so the loader's object is the caller's
      return result.value;
    } finally {
      if (this.loading.get(key) === run) this.loading.delete(key);
    }
  }

  whyNotKept(result, store, tables, started, options) {
    if (store.uncacheable) return store.uncacheable.split(':')[0];
    if (!tables.length) return 'no tables';
    if (options.keep && !options.keep(result)) return 'refused';
    if (this.tracker.changedSince(tables, started)) return 'changed while loading';
    for (const t of tables) {
      if (!this.tracker.known.has(t)) {
        this.warn(`[read-cache] "${t}" is not a table of this database: nothing depending on it is kept`);
        return 'unknown table';
      }
    }
    return null;
  }

  /** A sampled hit: load again and compare with what is kept. */
  async verify(key, entry, loader) {
    this.counts.verified++;
    const started = this.tracker.now();
    const { result, store } = await this.tracker.captureReads(loader);
    const tables = [...new Set([...entry.tables, ...store.tables])];
    this.tracker.noteRead(tables, store.uncacheable);
    const changed = this.tracker.changedSince(tables, Math.min(started, entry.started));
    let same;
    try {
      same = JSON.stringify(result) === JSON.stringify(entry.value);
    } catch {
      same = false;
    }
    if (!same && !changed) {
      this.counts.mismatches++;
      const message =
        `[read-cache] STALE entry: "${key}" differs from the database although none of its tables changed ` +
        `(${entry.tables.join(', ')}); entry dropped`;
      if (this.log && this.log.error) this.log.error(message);
      if (this.entries.get(key) === entry) this.remove(key, 'dropped');
    }
    return result;
  }

  store(key, entry) {
    if (this.entries.has(key)) this.remove(key, null);
    entry.key = key;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    for (const t of entry.tables) {
      if (!this.byTable.has(t)) this.byTable.set(t, new Set());
      this.byTable.get(t).add(key);
    }
    this.counts.stored++;
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      this.remove(oldest, 'evicted');
    }
  }

  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  remove(key, reason) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    for (const t of entry.tables) {
      const keys = this.byTable.get(t);
      if (keys) {
        keys.delete(key);
        if (!keys.size) this.byTable.delete(t);
      }
    }
    if (reason) this.counts[reason]++;
  }

  /** Frees the entries a change made stale (they would fail isValid anyway). */
  dropChanged(tables) {
    if (tables === null) {
      for (const key of [...this.entries.keys()]) this.remove(key, 'dropped');
      return;
    }
    for (const t of tables) {
      const keys = this.byTable.get(t);
      if (!keys) continue;
      for (const key of [...keys]) {
        const entry = this.entries.get(key);
        if (entry && this.tracker.changedSince(entry.tables, entry.started)) this.remove(key, 'dropped');
      }
    }
  }

  /** Drops everything; loads in progress won't be kept either. */
  clear(reason = 'clear') {
    this.tracker.everythingChanged(reason);
  }

  stats() {
    return {
      on: this.isOn(),
      failure: this.tracker.failure ? this.tracker.failure.message : null,
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      verifyRate: this.verifyRate,
      ...this.counts,
      tracker: { ...this.tracker.stats, tables: this.tracker.tables.length },
      stamps: this.stamps ? { ...this.stamps.stats, watched: this.stamps.watched.size } : null,
    };
  }

  warn(message) {
    const now = this.clock();
    this.lastWarn = this.lastWarn || new Map();
    if (this.lastWarn.has(message) && now - this.lastWarn.get(message) < 60 * 1000) return;
    this.lastWarn.set(message, now);
    if (this.log && this.log.warn) this.log.warn(message);
  }
}

module.exports = { ReadCache, MB };
