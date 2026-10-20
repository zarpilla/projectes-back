'use strict';

/**
 * issues/307 — the read cache turns itself on at the end of bootstrap only if
 * change detection is proven to work. What must hold:
 *   - READ_CACHE=false, or a database other than MySQL: off;
 *   - the hook did not see a probe statement (pool.afterCreate missing), or
 *     did not see a probe transaction's BEGIN and COMMIT: off, with an error;
 *   - the schema or the first stamps reading failed: off, with an error;
 *   - otherwise on, with the schema loaded and the master tables' stamps read;
 *   - a change of the role permission tables clears the roles' permissions
 *     kept in memory (role-permissions-cache.js), also when seen by SQL.
 */

const KEY_CACHE = Symbol.for('esstrapis.readCache.cache');
const KEY_TRACKER = Symbol.for('esstrapis.readCache.tracker');

let logs;
let options;

beforeEach(() => {
  jest.resetModules();
  delete globalThis[KEY_CACHE];
  delete globalThis[KEY_TRACKER];
  delete process.env.READ_CACHE;
  logs = { info: [], error: [], warn: [] };
  options = { hooked: true, txHooked: true, schemaFails: false, stampsFail: false, client: 'mysql' };
});

afterEach(() => {
  delete globalThis[KEY_CACHE];
  delete globalThis[KEY_TRACKER];
});

// a knex whose statements reach the tracker the way the hook reports them
function fakeKnex(tracker) {
  const send = (conn, sql) => {
    if (!options.hooked) return;
    if (!options.txHooked && conn === 'tx') return;
    tracker.statementEnded(conn, tracker.statementStarted(conn, sql));
  };
  const answer = (sql) => {
    if (/information_schema\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_TYPE/.test(sql)) {
      if (options.schemaFails) throw new Error('no access to information_schema');
      return [
        [
          { name: 'project_types' },
          { name: 'up_permissions' },
          { name: 'up_roles' },
          { name: 'up_permissions_role_lnk' },
        ],
      ];
    }
    if (/REFERENTIAL_CONSTRAINTS/.test(sql)) return [[]];
    if (/UNIX_TIMESTAMP\(\) AS now/.test(sql)) {
      if (options.stampsFail) throw new Error('stamps down');
      return [[{ now: 1000 }]];
    }
    if (/Uptime/.test(sql)) return [[{ started: 1 }]];
    if (/UPDATE_TIME/.test(sql)) return [[]];
    return [[]];
  };
  const raw = (conn) => async (sql) => {
    send(conn, sql);
    return answer(sql);
  };
  return {
    raw: raw('c1'),
    transaction: async (fn) => {
      send('tx', 'BEGIN;');
      const result = await fn({ raw: raw('tx') });
      send('tx', 'COMMIT;');
      return result;
    },
  };
}

function fakeStrapi() {
  const { getTracker } = require('../src/services/read-cache/change-tracker');
  const tracker = getTracker();
  return {
    log: {
      info: (m) => logs.info.push(m),
      error: (m) => logs.error.push(m),
      warn: (m) => logs.warn.push(m),
    },
    config: { get: () => options.client },
    db: {
      connection: fakeKnex(tracker),
      inTransaction: () => false,
      metadata: {
        get: (uid) =>
          uid === 'api::project-type.project-type' ? { tableName: 'project_types', attributes: {} } : null,
      },
    },
  };
}

const init = (extra) => require('../src/services/read-cache').initReadCache(fakeStrapi(), extra);

describe('initReadCache', () => {
  it('turns on when the hook sees the probes and the stamps can be read', async () => {
    const cache = await init();
    expect(cache.isOn()).toBe(true);
    expect(cache.tracker.tables).toContain('project_types');
    expect(cache.stamps.watched.has('project_types')).toBe(true);
    expect(cache.stamps.completed()).toBe(1);
    expect(logs.error).toEqual([]);
  });

  it('READ_CACHE=false: off', async () => {
    process.env.READ_CACHE = 'false';
    const cache = await init();
    expect(cache.isOn()).toBe(false);
    expect(logs.info.join()).toMatch(/READ_CACHE=false/);
  });

  it('not MySQL: off', async () => {
    options.client = 'sqlite';
    const cache = await init();
    expect(cache.isOn()).toBe(false);
  });

  it('the hook is missing: off, with an error', async () => {
    options.hooked = false;
    const cache = await init();
    expect(cache.isOn()).toBe(false);
    expect(logs.error.join()).toMatch(/did not see a probe statement/);
  });

  it('the hook misses transactions: off, with an error', async () => {
    options.txHooked = false;
    const cache = await init();
    expect(cache.isOn()).toBe(false);
    expect(logs.error.join()).toMatch(/probe transaction/);
  });

  it('the tables cannot be read: off', async () => {
    options.schemaFails = true;
    const cache = await init();
    expect(cache.isOn()).toBe(false);
    expect(logs.error.join()).toMatch(/information_schema/);
  });

  it('the first stamps reading fails: off', async () => {
    options.stampsFail = true;
    const cache = await init();
    expect(cache.isOn()).toBe(false);
    expect(logs.error.join()).toMatch(/stamps down/);
  });

  it('a change of the role permission tables clears the roles’ permissions in memory', async () => {
    const onPermissionsChange = jest.fn();
    const cache = await init({ onPermissionsChange });
    const t = cache.tracker;
    t.statementEnded('c9', t.statementStarted('c9', 'update `project_types` set name = ?'));
    expect(onPermissionsChange).not.toHaveBeenCalled();
    t.statementEnded('c9', t.statementStarted('c9', 'UPDATE up_permissions SET action = ? WHERE id = ?'));
    expect(onPermissionsChange).toHaveBeenCalled();
  });
});
