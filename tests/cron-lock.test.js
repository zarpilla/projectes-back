'use strict';

/**
 * Cron tasks and zero-downtime deploys (2026-10-09).
 *
 * 1. During a zero-downtime deploy the old and the new backend of a tenant
 *    overlap for a few seconds, both running the cron schedule. withCronLock
 *    makes each task take a MySQL named lock (scoped to the tenant database,
 *    since all tenants share the MySQL server) and skip when it is taken, so a
 *    job like the FACe retry never runs twice at once.
 * 2. Regression: the totals drain (every 2 min) required
 *    './src/api/project/services/totalsRefreshScheduler' from config/cron.js,
 *    which resolves to config/src/... and threw MODULE_NOT_FOUND on every run
 *    since 2026-08-25, silently: dirty projects were never recomputed by cron.
 */

const path = require('path');

const LOCK = path.join(__dirname, '..', 'src', 'services', 'cron-lock.js');
const CRON = path.join(__dirname, '..', 'config', 'cron.js');

function fakeStrapi({ client = 'mysql', database = 'arada_v5', got = 1 } = {}) {
  const calls = [];
  const trx = {
    raw: jest.fn(async (sql, bindings) => {
      calls.push([sql, bindings]);
      return sql.startsWith('SELECT GET_LOCK') ? [[{ got }]] : [[{}]];
    }),
  };
  return {
    calls,
    trx,
    config: { get: (key) => (key === 'database.connection' ? { client, connection: { database } } : undefined) },
    db: { connection: { transaction: jest.fn(async (cb) => cb(trx)) } },
    log: { info: jest.fn(), error: jest.fn() },
    service: jest.fn(),
    controller: jest.fn(),
  };
}

describe('withCronLock', () => {
  beforeEach(() => jest.resetModules());

  test('runs the task holding a lock named after the tenant database, then releases it', async () => {
    const { withCronLock } = require(LOCK);
    const s = fakeStrapi({ database: 'diligencia_v5' });
    const fn = jest.fn(async () => 'done');
    expect(await withCronLock('face-retry-pending', fn, s)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.calls).toEqual([
      ['SELECT GET_LOCK(?, 0) AS got', ['cron:diligencia_v5:face-retry-pending']],
      ['SELECT RELEASE_LOCK(?)', ['cron:diligencia_v5:face-retry-pending']],
    ]);
  });

  test('skips the task when another instance holds the lock', async () => {
    const { withCronLock } = require(LOCK);
    const s = fakeStrapi({ got: 0 });
    const fn = jest.fn();
    expect(await withCronLock('face-retry-pending', fn, s)).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    expect(s.calls.map(([sql]) => sql)).toEqual(['SELECT GET_LOCK(?, 0) AS got']);
    expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  test('releases the lock when the task throws', async () => {
    const { withCronLock } = require(LOCK);
    const s = fakeStrapi();
    await expect(withCronLock('x', async () => { throw new Error('boom'); }, s)).rejects.toThrow('boom');
    expect(s.calls.map(([sql]) => sql)).toEqual(['SELECT GET_LOCK(?, 0) AS got', 'SELECT RELEASE_LOCK(?)']);
  });

  test('lock names stay within MySQL\'s 64 characters and differ per database', () => {
    const { lockName } = require(LOCK);
    const long = lockName('a_very_long_database_name_for_a_tenant_v5', 'face-check-status');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(lockName('a_v5', 'task')).not.toBe(lockName('b_v5', 'task'));
  });

  test('runs the task directly on databases without named locks (sqlite in development)', async () => {
    const { withCronLock } = require(LOCK);
    const s = fakeStrapi({ client: 'sqlite' });
    const fn = jest.fn(async () => 1);
    expect(await withCronLock('x', fn, s)).toBe(1);
    expect(s.db.connection.transaction).not.toHaveBeenCalled();
  });
});

describe('config/cron.js', () => {
  beforeEach(() => {
    jest.resetModules();
    global.strapi = fakeStrapi({ client: 'sqlite' });
  });
  afterEach(() => { delete global.strapi; });

  test('the totals drain finds its module and runs (it threw MODULE_NOT_FOUND before)', async () => {
    const processDirty = jest.fn(async () => {});
    jest.doMock(path.join(__dirname, '..', 'src', 'api', 'project', 'services', 'totalsRefreshScheduler.js'), () => ({ processDirty }));
    const cron = require(CRON);
    await cron['*/2 * * * *'].task({ strapi: global.strapi });
    expect(processDirty).toHaveBeenCalledTimes(1);
  });

  test('every task goes through the lock', async () => {
    global.strapi = fakeStrapi({ got: 0 });
    const cron = require(CRON);
    for (const [schedule, job] of Object.entries(cron)) {
      global.strapi.db.connection.transaction.mockClear();
      await job.task({ strapi: global.strapi });
      expect([schedule, global.strapi.db.connection.transaction.mock.calls.length]).toEqual([schedule, 1]);
    }
    // The lock was never granted, so no task body ran.
    expect(global.strapi.service).not.toHaveBeenCalled();
    expect(global.strapi.controller).not.toHaveBeenCalled();
  });
});
