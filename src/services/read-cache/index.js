'use strict';

/**
 * The read cache of this process (issues/307): wiring and start-up.
 *
 * Pieces (each file explains itself):
 *   mysql-hook.js     every statement sent on the pool's connections → tracker
 *   change-tracker.js when each table last changed, from those statements
 *   table-stamps.js   writes from outside the process, from MySQL's stamps
 *   read-cache.js     get(key, loader, { tables }): answers kept until stale
 *   routes.js         the GET routes served from it (the master tables)
 *
 * `initReadCache` runs at the end of bootstrap. The cache stays off (every
 * request goes to the database, as before) unless all of this holds:
 *   - READ_CACHE is not "false" and the database is MySQL;
 *   - a probe statement, and a probe transaction's BEGIN and COMMIT, were
 *     seen by the hook: proof that change detection sees this process's
 *     statements;
 *   - the tables and foreign keys were read, and a first reading of the
 *     table stamps worked.
 *
 * Settings (environment):
 *   READ_CACHE=false            off (and the hook isn't installed)
 *   READ_CACHE_MAX_MB=64        memory cap of the kept answers
 *   READ_CACHE_TTL_S=600        an answer is never kept longer than this
 *   READ_CACHE_STAMPS_MS=2000   how old the stamps of MySQL may be when an
 *                               answer is served (writes from outside the
 *                               process are seen within this, + 2 s)
 *   READ_CACHE_VERIFY=0.05      share of hits loaded again and compared
 *                               (0..1); a difference is logged as an error.
 *                               5 % for the first weeks in production
 *                               (2026-10-21); then 0. Big datasets set
 *                               their own 0 (a check would redo the load).
 *   READ_CACHE_LOG_SLOW_MS=1000 a load someone waits this long or more is
 *                               logged («[read-cache] slow load: …»)
 */

const { getTracker } = require('./change-tracker');
const { ReadCache, MB } = require('./read-cache');
const { TableStamps, stampReader } = require('./table-stamps');
const { loadSchema } = require('./schema');
const { COLUMN_GROUPS } = require('./column-groups');
const { CACHED_ROUTES, PERMISSION_TABLES, tablesOf } = require('./routes');

const KEY = Symbol.for('esstrapis.readCache.cache');

// the share of hits checked against the database when READ_CACHE_VERIFY isn't
// set: on for the first weeks in production, to see a detection failure in
// the logs («[read-cache] STALE entry») if there is one
const DEFAULT_VERIFY_RATE = 0.05;

const number = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

const isEnabledByEnv = () => process.env.READ_CACHE !== 'false';

/** The process-wide cache. Off until initReadCache succeeds. */
function getReadCache() {
  if (!globalThis[KEY]) {
    globalThis[KEY] = new ReadCache({
      tracker: getTracker(),
      maxBytes: number(process.env.READ_CACHE_MAX_MB, 64) * MB,
      ttlMs: number(process.env.READ_CACHE_TTL_S, 600) * 1000,
      verifyRate: Math.min(1, number(process.env.READ_CACHE_VERIFY, DEFAULT_VERIFY_RATE)),
      slowLoadMs: number(process.env.READ_CACHE_LOG_SLOW_MS, 1000),
    });
  }
  return globalThis[KEY];
}

/**
 * Sends a probe statement and a probe transaction, and checks the hook saw
 * them: the statement's start and end, and BEGIN, the transaction's statement
 * and COMMIT on one connection.
 */
async function probeHook(knex, tracker) {
  const marker = `read_cache_probe_${process.pid}_${Date.now()}`;
  const seen = [];
  const stop = tracker.watchStatements((event, connection, sql) =>
    seen.push({ event, connection, sql: String(sql) }),
  );
  try {
    await knex.raw(`SELECT 1 AS ${marker}`);
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT 2 AS ${marker}_tx`);
    });
  } finally {
    stop();
  }
  const plain = seen.filter((s) => s.sql.includes(`${marker}`) && !s.sql.includes(`${marker}_tx`));
  if (!plain.some((s) => s.event === 'start') || !plain.some((s) => s.event === 'end')) {
    throw new Error(
      'the hook did not see a probe statement (is pool.afterCreate set in config/database.js?)',
    );
  }
  const inTx = seen.find((s) => s.event === 'start' && s.sql.includes(`${marker}_tx`));
  if (!inTx) throw new Error('the hook did not see the probe transaction');
  const onConnection = seen.filter((s) => s.connection === inTx.connection);
  const saw = (pattern, event) => onConnection.some((s) => s.event === event && pattern.test(s.sql));
  if (!saw(/^BEGIN/i, 'end') || !saw(/^COMMIT/i, 'start') || !saw(/^COMMIT/i, 'end')) {
    throw new Error('the hook did not see the probe transaction’s BEGIN and COMMIT');
  }
}

/** The tables the cached routes depend on: their stamps are read from the start. */
function routeTablesOf(strapi) {
  const tables = new Set(PERMISSION_TABLES);
  for (const name of Object.keys(CACHED_ROUTES)) {
    for (const t of tablesOf(strapi, `api::${name}.${name}`)) tables.add(t);
  }
  return [...tables];
}

let schemaReload = null;

async function initReadCache(strapi, { onPermissionsChange } = {}) {
  const cache = getReadCache();
  const tracker = getTracker();
  tracker.setLogger(strapi.log);
  cache.log = strapi.log;

  if (!isEnabledByEnv()) {
    strapi.log.info('[read-cache] off (READ_CACHE=false)');
    return cache;
  }
  const client = strapi.config.get('database.connection.client');
  if (!['mysql', 'mysql2'].includes(client)) {
    strapi.log.info(`[read-cache] off: only on MySQL (database client: ${client})`);
    return cache;
  }

  try {
    const knex = strapi.db.connection;
    await probeHook(knex, tracker);
    tracker.setColumnGroups(COLUMN_GROUPS);
    tracker.setSchema(await loadSchema(knex));

    // DDL changes the tables: read them again (the tracker already counted
    // everything as changed)
    tracker.onSchemaChange(() => {
      if (schemaReload) return;
      schemaReload = setTimeout(() => {
        schemaReload = null;
        loadSchema(knex)
          .then((schema) => tracker.setSchema(schema))
          .catch((error) => tracker.fail(new Error(`schema reload failed: ${error && error.message}`)));
      }, 1000);
      if (schemaReload.unref) schemaReload.unref();
    });

    const stamps = new TableStamps({
      tracker,
      read: stampReader(knex),
      intervalMs: number(process.env.READ_CACHE_STAMPS_MS, 2000),
    });
    stamps.watch(routeTablesOf(strapi));
    await stamps.check();
    cache.stamps = stamps;
    cache.inTransaction = () => Boolean(strapi.db.inTransaction && strapi.db.inTransaction());

    // other in-memory copies of the permissions follow the same detection
    if (onPermissionsChange) {
      tracker.onChange((tables) => {
        if (tables === null || tables.some((t) => PERMISSION_TABLES.includes(t))) onPermissionsChange();
      });
    }

    cache.enable();
    strapi.log.info(
      `[read-cache] on: ${tracker.tables.length} tables watched for changes, ` +
        `${stamps.watched.size} stamped, cap ${Math.round(cache.maxBytes / MB)} MB, ttl ${Math.round(cache.ttlMs / 1000)} s` +
        (cache.verifyRate ? `, verifying ${cache.verifyRate * 100}% of hits` : ''),
    );
  } catch (error) {
    cache.disable();
    strapi.log.error(`[read-cache] off: ${error && error.message}`);
  }
  return cache;
}

module.exports = { getReadCache, initReadCache, isEnabledByEnv, probeHook };
