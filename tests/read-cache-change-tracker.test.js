'use strict';

/**
 * issues/307 — the change tracker decides when a cached result is stale. It is
 * fed the statements every MySQL connection of the process sends (start and
 * end, as mysql-hook.js reports them). What must hold, for every way data can
 * change in this backend:
 *   - a result loaded before a write, or during it, is stale once the write is
 *     visible to other connections: at the end of the statement outside a
 *     transaction, at the end of the COMMIT inside one;
 *   - a result loaded while another connection's transaction is still open
 *     (it read the old, committed data) is stale after that COMMIT;
 *   - savepoints, other connections' commits and session statements never
 *     make a transaction's pending writes be forgotten;
 *   - a delete cascades through foreign keys: the child tables change too;
 *   - anything the tracker can't read (unknown statement, write to an
 *     unknown table, DDL) is a change of every table;
 *   - reads inside captureReads() are recorded; a load that writes, or reads
 *     no known table, is marked as not cacheable.
 */

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');

const SCHEMA = {
  tables: [
    'project_types',
    'projects',
    'projects_project_type_lnk',
    'projects_cmps',
    'components_project_phases',
    'cities',
    'regions',
    'cities_region_lnk',
    'users-permissions_user',
    'orders',
  ],
  foreignKeys: [
    // link tables cascade from both sides
    {
      table: 'projects_project_type_lnk',
      referencedTable: 'projects',
      deleteRule: 'CASCADE',
      updateRule: 'NO ACTION',
    },
    {
      table: 'projects_project_type_lnk',
      referencedTable: 'project_types',
      deleteRule: 'CASCADE',
      updateRule: 'NO ACTION',
    },
    { table: 'projects_cmps', referencedTable: 'projects', deleteRule: 'CASCADE', updateRule: 'NO ACTION' },
    // a grandchild: deleting a project reaches it through projects_cmps
    {
      table: 'components_project_phases',
      referencedTable: 'projects_cmps',
      deleteRule: 'CASCADE',
      updateRule: 'NO ACTION',
    },
    {
      table: 'cities_region_lnk',
      referencedTable: 'regions',
      deleteRule: 'SET NULL',
      updateRule: 'NO ACTION',
    },
    // refused, not cascaded: deleting a city doesn't change orders
    { table: 'orders', referencedTable: 'cities', deleteRule: 'RESTRICT', updateRule: 'RESTRICT' },
  ],
};

let tracker;

beforeEach(() => {
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema(SCHEMA);
});

// a statement on a connection, start and end, the way the hook reports it
const run = (conn, sql, values) => tracker.statementEnded(conn, tracker.statementStarted(conn, sql, values));
const start = (conn, sql) => tracker.statementStarted(conn, sql);
const end = (conn, statement) => tracker.statementEnded(conn, statement);

// a "load" is just the counter at which it began
const load = () => tracker.now();
const stale = (tables, at) => tracker.changedSince(tables, at);

describe('a write outside a transaction', () => {
  it('makes a result loaded before it stale', () => {
    const at = load();
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('makes a result loaded while it runs stale once it ends', () => {
    const w = start('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load(); // read on another connection while the update runs
    expect(stale(['project_types'], at)).toBe(false);
    end('c1', w);
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('leaves results of other tables alone', () => {
    const at = load();
    run('c1', 'update `cities` set `name` = ? where `id` = ?');
    expect(stale(['project_types', 'regions'], at)).toBe(false);
  });

  it('a result loaded after it is good', () => {
    run('c1', 'insert into `project_types` (`name`) values (?)');
    const at = load();
    expect(stale(['project_types'], at)).toBe(false);
  });

  it('raw SQL is seen like any other statement', () => {
    const at = load();
    run('c1', 'UPDATE project_types SET name = ? WHERE id = ?');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('a failed write still counts (it ended)', () => {
    const at = load();
    const w = start('c1', 'insert into `project_types` (`id`) values (?)');
    end('c1', w); // the hook calls end on errors too
    expect(stale(['project_types'], at)).toBe(true);
  });
});

describe('a write inside a transaction', () => {
  it('a result loaded between the write and the COMMIT is stale after the COMMIT', () => {
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load(); // another connection reads the old, committed row
    expect(stale(['project_types'], at)).toBe(false);
    const commit = start('c1', 'COMMIT;');
    expect(stale(['project_types'], at)).toBe(false);
    end('c1', commit);
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('also after a ROLLBACK (harmless)', () => {
    run('c1', 'BEGIN;');
    run('c1', 'delete from `project_types` where `id` = ?');
    const at = load();
    run('c1', 'ROLLBACK');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('savepoints never drop the pending writes before the COMMIT', () => {
    run('c1', 'BEGIN;');
    run('c1', 'SAVEPOINT trx2;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    run('c1', 'RELEASE SAVEPOINT trx2;');
    run('c1', 'SAVEPOINT trx3;');
    run('c1', 'ROLLBACK TO SAVEPOINT trx3');
    const at = load();
    run('c1', 'select * from `project_types`');
    run('c1', 'COMMIT;');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('another connection committing never drops this connection’s pending writes', () => {
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    run('c2', 'BEGIN;');
    run('c2', 'update `cities` set `name` = ? where `id` = ?');
    run('c2', 'COMMIT;');
    const at = load();
    run('c1', 'COMMIT;');
    expect(stale(['project_types'], at)).toBe(true);
    expect(stale(['cities'], at)).toBe(false);
  });

  it('a COMMIT forgets the pending writes: a later COMMIT on the same connection is quiet', () => {
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    run('c1', 'COMMIT;');
    const at = load();
    run('c1', 'BEGIN;');
    run('c1', 'update `cities` set `name` = ? where `id` = ?');
    run('c1', 'COMMIT;');
    expect(stale(['project_types'], at)).toBe(false);
    expect(stale(['cities'], at)).toBe(true);
  });

  it('DDL inside a transaction commits it implicitly: everything is stale', () => {
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load();
    run('c1', 'alter table `cities` add `x` int');
    expect(stale(['regions'], at)).toBe(true);
  });

  it('SET autocommit = 1 commits implicitly: pending writes are stamped', () => {
    run('c1', 'set autocommit = 0');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load();
    run('c1', 'set autocommit = 1');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('a connection that closes with pending writes stamps them', () => {
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load();
    tracker.connectionClosed('c1');
    expect(stale(['project_types'], at)).toBe(true);
  });

  it('a COMMIT that never answers (no end) leaves the result good until something ends', () => {
    // the hook always reports an end (the driver calls back on errors and
    // closed connections); this documents that the end is what counts
    run('c1', 'BEGIN;');
    run('c1', 'update `project_types` set `name` = ? where `id` = ?');
    const at = load();
    start('c1', 'COMMIT;');
    expect(stale(['project_types'], at)).toBe(false);
    tracker.connectionClosed('c1');
    expect(stale(['project_types'], at)).toBe(true);
  });
});

describe('which tables a statement touches', () => {
  it('every known table named in it', () => {
    const at = load();
    run(
      'c1',
      'update `projects` set `dirty` = ? where `id` in (select `project_id` from `projects_project_type_lnk`)',
    );
    expect(stale(['projects'], at)).toBe(true);
    expect(stale(['projects_project_type_lnk'], at)).toBe(true);
    expect(stale(['cities'], at)).toBe(false);
  });

  it('link tables written by Strapi', () => {
    const at = load();
    run('c1', 'insert into `projects_project_type_lnk` (`project_id`, `project_type_id`) values (?, ?)');
    expect(stale(['projects_project_type_lnk'], at)).toBe(true);
  });

  it('names with a dash, in any case', () => {
    const at = load();
    run('c1', 'UPDATE `Users-Permissions_User` SET x = 1');
    expect(stale(['users-permissions_user'], at)).toBe(true);
  });

  it('identifiers passed as ?? values', () => {
    const at = load();
    run('c1', 'update ?? set name = ?', ['cities', 'x']);
    expect(stale(['cities'], at)).toBe(true);
  });

  it('a delete reaches the tables its foreign keys cascade to, transitively', () => {
    const at = load();
    run('c1', 'delete from `projects` where `id` = ?');
    expect(stale(['projects_project_type_lnk'], at)).toBe(true);
    expect(stale(['projects_cmps'], at)).toBe(true);
    expect(stale(['components_project_phases'], at)).toBe(true);
  });

  it('ON DELETE SET NULL changes the child table too', () => {
    const at = load();
    run('c1', 'delete from `regions` where `id` = ?');
    expect(stale(['cities_region_lnk'], at)).toBe(true);
  });

  it('RESTRICT foreign keys are not followed', () => {
    const at = load();
    run('c1', 'delete from `cities` where `id` = ?');
    expect(stale(['orders'], at)).toBe(false);
  });

  it('a cascade inside a transaction is stamped again at the COMMIT', () => {
    run('c1', 'BEGIN;');
    run('c1', 'delete from `projects` where `id` = ?');
    const at = load();
    run('c1', 'COMMIT;');
    expect(stale(['components_project_phases'], at)).toBe(true);
  });
});

describe('what counts as a change of everything', () => {
  it.each([
    ['an unknown statement', 'CALL do_something()'],
    ['a write naming no known table', 'insert into `not_a_table` values (1)'],
    ['DDL', 'create table `new_one` (`id` int)'],
    ['TRUNCATE', 'truncate `cities`'],
    ['two statements in one', 'select 1; delete from x'],
  ])('%s', (_label, sql) => {
    const at = load();
    run('c1', sql);
    expect(stale(['regions'], at)).toBe(true);
  });

  it('reads and session statements change nothing', () => {
    const at = load();
    run('c1', 'select * from `cities`');
    run('c1', 'SET NAMES utf8mb4');
    run('c1', 'show tables');
    expect(stale(['cities', 'regions', 'project_types'], at)).toBe(false);
  });

  it('a new schema is a change of everything', () => {
    const at = load();
    tracker.setSchema(SCHEMA);
    expect(stale(['cities'], at)).toBe(true);
  });

  it('before the schema is known, every write is a change of everything', () => {
    const fresh = new ChangeTracker();
    fresh.setLogger({ warn: () => {} });
    const at = fresh.now();
    fresh.statementEnded('c1', fresh.statementStarted('c1', 'update `cities` set x = 1'));
    expect(fresh.changedSince(['regions'], at)).toBe(true);
  });

  it('a failure of the tracker is a change of everything and is remembered', () => {
    const at = load();
    tracker.fail(new Error('boom'));
    expect(tracker.failure).toBeTruthy();
    expect(stale(['cities'], at)).toBe(true);
  });

  it('DDL asks for the schema to be read again', () => {
    const reload = jest.fn();
    tracker.onSchemaChange(reload);
    run('c1', 'alter table `cities` add `x` int');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('listeners', () => {
  it('are told which tables changed, or null for everything', () => {
    const seen = [];
    tracker.onChange((tables) => seen.push(tables && [...tables].sort()));
    run('c1', 'update `cities` set x = 1');
    run('c1', 'CALL x()');
    expect(seen).toContainEqual(['cities']);
    expect(seen).toContainEqual(null);
  });

  it('a failing listener does not stop the others', () => {
    const second = jest.fn();
    tracker.onChange(() => {
      throw new Error('boom');
    });
    tracker.onChange(second);
    run('c1', 'update `cities` set x = 1');
    expect(second).toHaveBeenCalled();
  });
});

describe('captureReads', () => {
  it('records the known tables its reads touch', async () => {
    const { result, store } = await tracker.captureReads(async () => {
      run(
        'c1',
        'select * from `cities` as `t0` left join `cities_region_lnk` as `t1` on `t0`.`id` = `t1`.`city_id`',
      );
      await Promise.resolve();
      run('c2', 'select * from `regions`');
      return 42;
    });
    expect(result).toBe(42);
    expect([...store.tables].sort()).toEqual(['cities', 'cities_region_lnk', 'regions']);
    expect(store.uncacheable).toBeNull();
  });

  it('records the reads of a lazy thenable (a knex builder runs when awaited)', async () => {
    const builder = {
      then(resolve, reject) {
        try {
          run('c1', 'select * from `cities`');
          resolve(['row']);
        } catch (error) {
          reject(error);
        }
      },
    };
    const { result, store } = await tracker.captureReads(() => builder);
    expect(result).toEqual(['row']);
    expect([...store.tables]).toEqual(['cities']);
  });

  it('keeps concurrent captures apart', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const [a, b] = await Promise.all([
      tracker.captureReads(async () => {
        await tick();
        run('c1', 'select * from `cities`');
        await tick();
      }),
      tracker.captureReads(async () => {
        run('c2', 'select * from `regions`');
        await tick();
        run('c2', 'select * from `project_types`');
      }),
    ]);
    expect([...a.store.tables]).toEqual(['cities']);
    expect([...b.store.tables].sort()).toEqual(['project_types', 'regions']);
  });

  it('a load that writes is not cacheable', async () => {
    const { store } = await tracker.captureReads(async () => {
      run('c1', 'select * from `activity_types`');
      run('c1', 'update `cities` set x = 1');
    });
    expect(store.uncacheable).toMatch(/writes/);
  });

  it('a load that reads no known table is not cacheable', async () => {
    const { store } = await tracker.captureReads(async () => {
      run('c1', 'select 1');
    });
    expect(store.uncacheable).toMatch(/no known table/);
  });

  it('transactions and session statements in a load are fine', async () => {
    const { store } = await tracker.captureReads(async () => {
      run('c1', 'BEGIN;');
      run('c1', 'select * from `cities`');
      run('c1', 'COMMIT;');
      run('c1', 'SET NAMES utf8mb4');
    });
    expect(store.uncacheable).toBeNull();
  });

  it('noteRead adds tables read some other way to the current capture only', async () => {
    tracker.noteRead(['cities']); // outside a capture: nothing happens
    const { store } = await tracker.captureReads(async () => {
      tracker.noteRead(['regions'], 'inner not kept');
    });
    expect([...store.tables]).toEqual(['regions']);
    expect(store.uncacheable).toBe('inner not kept');
  });

  it('reads outside a capture are not recorded anywhere', async () => {
    run('c1', 'select * from `cities`');
    const { store } = await tracker.captureReads(async () => {
      run('c1', 'select * from `regions`');
    });
    expect([...store.tables]).toEqual(['regions']);
  });
});

describe('externalChange', () => {
  it('stamps the tables and their cascades', () => {
    const at = load();
    tracker.externalChange(['Projects']);
    expect(stale(['projects'], at)).toBe(true);
    expect(stale(['components_project_phases'], at)).toBe(true);
    expect(stale(['cities'], at)).toBe(false);
  });
});

describe('watchStatements', () => {
  it('sees every start and end with its connection and text, until stopped', () => {
    const seen = [];
    const stop = tracker.watchStatements((event, conn, sql) => seen.push([event, conn, sql]));
    run('c1', 'BEGIN;');
    run('c1', 'update `cities` set x = 1');
    stop();
    run('c1', 'COMMIT;');
    expect(seen).toEqual([
      ['start', 'c1', 'BEGIN;'],
      ['end', 'c1', 'BEGIN;'],
      ['start', 'c1', 'update `cities` set x = 1'],
      ['end', 'c1', 'update `cities` set x = 1'],
    ]);
  });
});
