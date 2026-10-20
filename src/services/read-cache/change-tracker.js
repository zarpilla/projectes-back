'use strict';

/**
 * Knows when each table last changed (issues/307).
 *
 * Every statement this process sends to MySQL passes through the hook in
 * mysql-hook.js, which reports its start and its end here. From the statement
 * the tracker works out which tables it can change, and moves a counter: each
 * change takes the next number and stamps it on the tables it touched. A cached
 * result remembers the number at which its load began, and is still good only
 * while none of the tables it depends on has a later stamp.
 *
 * When a change becomes visible to the other connections:
 *   - a write outside a transaction: when the statement ends;
 *   - a write inside a transaction: when the COMMIT ends.
 * The tracker stamps the tables at both moments (and also when the write
 * starts). It doesn't need to know whether a connection is in a transaction:
 * every table a connection writes stays pending on it until a full COMMIT or
 * ROLLBACK, and the end of every transaction-control or session statement
 * (BEGIN, COMMIT, ROLLBACK, SAVEPOINT, SET, DDL's implicit commit...) stamps the
 * pending tables again. Extra stamps only cost a reload; a missing one would
 * serve stale data, so every doubt resolves into a stamp.
 *
 * A load that read data before a commit and finished after it sees that a
 * table changed during the load, so its result is not kept. A load that ran
 * entirely between the write and the commit read the old data, and the stamp
 * at the end of the COMMIT invalidates it.
 *
 * Which tables a statement touches: every known table whose name appears in
 * its text (a table is always named in the statement that writes it), plus
 * the tables its foreign keys cascade to (458 ON DELETE CASCADE and 193 SET
 * NULL in a tenant database: deleting a row changes link and component tables
 * that the statement doesn't name). A write that names no known table, an
 * unknown statement and any DDL count as a change of every table.
 *
 * Reads made inside `captureReads()` are recorded, so a cached result also
 * depends on every table its load actually read.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { classify } = require('./sql-statement');

const WARN_EVERY_MS = 60 * 1000;

class ChangeTracker {
  constructor() {
    this.counter = 0;
    this.changedAt = new Map(); // table -> counter of its last change
    this.clearedAt = 0; // counter of the last change of every table
    this.tables = []; // known table names, lower case
    this.known = new Set();
    this.cascades = new Map(); // table -> tables its foreign keys change
    this.pending = new Map(); // connection -> tables written since its last COMMIT/ROLLBACK
    this.listeners = new Set();
    this.watchers = new Set(); // see watchStatements
    this.capture = new AsyncLocalStorage();
    this.schemaLoaded = false;
    this.failure = null; // set when the tracker itself failed: the cache is then off
    this.log = null;
    this.lastWarn = new Map();
    this.stats = { statements: 0, writes: 0, everything: 0, everythingReasons: {} };
  }

  setLogger(log) {
    this.log = log;
  }

  /**
   * The database's tables and foreign keys, from information_schema. Replacing
   * them is a change of every table: what was cached was checked against the
   * old list.
   * @param {{ tables: string[], foreignKeys: { table: string, referencedTable: string, deleteRule?: string, updateRule?: string }[] }} schema
   */
  setSchema({ tables, foreignKeys = [] }) {
    this.tables = [...new Set(tables.map((t) => String(t).toLowerCase()))];
    this.known = new Set(this.tables);
    const children = new Map();
    for (const fk of foreignKeys) {
      const rules = [fk.deleteRule, fk.updateRule].map((r) => String(r || '').toUpperCase());
      // RESTRICT / NO ACTION refuse the write instead of changing the child
      if (!rules.some((r) => r === 'CASCADE' || r === 'SET NULL' || r === 'SET DEFAULT')) continue;
      const parent = String(fk.referencedTable).toLowerCase();
      const child = String(fk.table).toLowerCase();
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
    }
    this.cascades = new Map();
    for (const parent of children.keys()) {
      const reached = new Set();
      const queue = [...children.get(parent)];
      while (queue.length) {
        const t = queue.shift();
        if (reached.has(t)) continue;
        reached.add(t);
        for (const next of children.get(t) || []) queue.push(next);
      }
      reached.delete(parent);
      this.cascades.set(parent, reached);
    }
    this.schemaLoaded = true;
    this.everythingChanged('schema loaded');
  }

  /** Known tables named in a statement (and in its values, if it has `??`). */
  tablesIn(sql, values) {
    let text = String(sql).toLowerCase();
    if (text.includes('??') && Array.isArray(values)) {
      text +=
        ' ' +
        values
          .filter((v) => typeof v === 'string')
          .join(' ')
          .toLowerCase();
    }
    const found = [];
    for (const t of this.tables) if (text.includes(t)) found.push(t);
    return found;
  }

  /** The tables plus the ones their foreign keys cascade to. */
  withCascades(tables) {
    const all = new Set(tables);
    for (const t of tables) for (const c of this.cascades.get(t) || []) all.add(c);
    return [...all];
  }

  /** The counter now: what a load records when it begins. */
  now() {
    return this.counter;
  }

  /** True if any of the tables (or everything) changed after `since`. */
  changedSince(tables, since) {
    if (this.clearedAt > since) return true;
    for (const t of tables) {
      const at = this.changedAt.get(t);
      if (at !== undefined && at > since) return true;
    }
    return false;
  }

  /**
   * Calls fn(event, connection, sql) for every statement's 'start' and 'end'
   * (the start-up self-test; diagnostics). Returns the function that stops it.
   */
  watchStatements(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Called with the changed tables, or null when everything changed. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  markChanged(tables) {
    if (!tables.length) return;
    this.counter++;
    for (const t of tables) this.changedAt.set(t, this.counter);
    this.notify(tables);
  }

  everythingChanged(reason) {
    this.counter++;
    this.clearedAt = this.counter;
    this.stats.everything++;
    this.stats.everythingReasons[reason] = (this.stats.everythingReasons[reason] || 0) + 1;
    this.notify(null);
  }

  notify(tables) {
    for (const fn of this.listeners) {
      try {
        fn(tables);
      } catch (error) {
        this.warn('listener', `[read-cache] change listener failed: ${error && error.message}`);
      }
    }
  }

  addPending(connection, tables) {
    let set = this.pending.get(connection);
    if (!set) this.pending.set(connection, (set = new Set()));
    for (const t of tables) set.add(t);
  }

  stampPending(connection) {
    const set = this.pending.get(connection);
    if (set && set.size) this.markChanged([...set]);
  }

  /**
   * A statement is about to be sent. Returns what `statementEnded` needs.
   * @param {*} connection any value that identifies the connection
   */
  statementStarted(connection, sql, values) {
    this.stats.statements++;
    const statement = classify(sql);
    if (this.watchers.size) {
      statement.sql = sql;
      for (const fn of this.watchers) fn('start', connection, sql);
    }
    const store = this.capture.getStore();

    if (statement.kind === 'read') {
      if (store) {
        const tables = this.tablesIn(sql, values);
        if (!tables.length) store.uncacheable = `read of no known table: ${String(sql).slice(0, 80)}`;
        for (const t of tables) store.tables.add(t);
      }
      return statement;
    }

    if (
      store &&
      (statement.kind === 'write' || statement.kind === 'schema' || statement.kind === 'unknown')
    ) {
      store.uncacheable = `the load writes: ${String(sql).slice(0, 80)}`;
    }

    if (statement.kind === 'write' || statement.kind === 'schema') {
      this.stats.writes++;
      const named = this.tablesIn(sql, values);
      const tables = this.withCascades(named);
      if (!named.length) {
        // before the schema is read (boot) every write is one of these
        if (this.schemaLoaded) {
          this.warn(
            'unknown-table',
            `[read-cache] write to no known table, everything dropped: ${String(sql).slice(0, 120)}`,
          );
        }
        this.everythingChanged('write to no known table');
      } else {
        this.markChanged(tables);
      }
      this.addPending(connection, tables);
      if (statement.kind === 'schema') this.everythingChanged('schema statement');
      statement.tables = tables;
      statement.named = named;
      return statement;
    }

    if (statement.kind === 'unknown') {
      this.warn(
        'unknown',
        `[read-cache] unknown statement, everything dropped: ${String(sql).slice(0, 120)}`,
      );
      this.everythingChanged('unknown statement');
    }
    return statement;
  }

  /** The statement's answer arrived (or it failed, or its connection broke). */
  statementEnded(connection, statement) {
    if (this.watchers.size && statement) for (const fn of this.watchers) fn('end', connection, statement.sql);
    if (!statement || statement.kind === 'read') return;
    if (statement.kind === 'write' || statement.kind === 'schema') {
      if (statement.named && !statement.named.length) this.everythingChanged('write to no known table');
      else this.markChanged(statement.tables);
      if (statement.kind === 'schema') {
        this.everythingChanged('schema statement');
        this.stampPending(connection);
        this.notifySchema();
      }
      return;
    }
    if (statement.kind === 'unknown') this.everythingChanged('unknown statement');
    // tx, session, unknown: the pending writes may have just become visible
    this.stampPending(connection);
    if (statement.kind === 'tx' && statement.endsTransaction) this.pending.delete(connection);
  }

  /** The connection is gone: whatever it had pending is stamped once more. */
  connectionClosed(connection) {
    this.stampPending(connection);
    this.pending.delete(connection);
  }

  /** Tables changed by someone else (another process, a manual edit). */
  externalChange(tables) {
    this.markChanged(this.withCascades(tables.map((t) => String(t).toLowerCase())));
  }

  onSchemaChange(fn) {
    this.schemaListener = fn;
  }

  notifySchema() {
    if (this.schemaListener) {
      try {
        this.schemaListener();
      } catch (error) {
        this.warn('schema', `[read-cache] schema reload failed: ${error && error.message}`);
      }
    }
  }

  /**
   * Runs `fn` recording the tables its reads touch. Returns its result and
   * `{ tables, uncacheable }`.
   */
  async captureReads(fn) {
    const store = { tables: new Set(), uncacheable: null };
    // awaited inside the context: a knex builder only runs its query when
    // awaited, and would otherwise run outside it, unrecorded
    const result = await this.capture.run(store, async () => await fn());
    return { result, store };
  }

  /** Inside a capture, adds tables read some other way (a cache hit). */
  noteRead(tables, uncacheable) {
    const store = this.capture.getStore();
    if (!store) return;
    for (const t of tables) store.tables.add(t);
    if (uncacheable && !store.uncacheable) store.uncacheable = uncacheable;
  }

  /** The hook or the tracker broke: nothing may be served from the cache. */
  fail(error) {
    if (!this.failure) {
      this.failure = error || new Error('read-cache tracker failed');
      this.warn('fail', `[read-cache] change detection failed, cache off: ${this.failure.message}`, true);
    }
    this.everythingChanged('tracker failure');
  }

  warn(kind, message, force) {
    const now = Date.now();
    if (!force && this.lastWarn.has(kind) && now - this.lastWarn.get(kind) < WARN_EVERY_MS) return;
    this.lastWarn.set(kind, now);
    const log = this.log || (global.strapi && global.strapi.log);
    if (log && log.warn) log.warn(message);
  }
}

const KEY = Symbol.for('esstrapis.readCache.tracker');

/** The process-wide tracker (config/database.js and src/ share it). */
function getTracker() {
  if (!globalThis[KEY]) globalThis[KEY] = new ChangeTracker();
  return globalThis[KEY];
}

module.exports = { ChangeTracker, getTracker };
