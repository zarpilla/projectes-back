'use strict';

/**
 * issues/328 — column groups against a real MySQL (see
 * read-cache-column-groups.test.js for why). Writes go through knex, as
 * Strapi's query builder sends them; every answer served from the cache is
 * compared with a direct read of the database:
 *   - a result that ignores `projects#totals` survives `dirty` / totals writes
 *     (plain and in a transaction), and is reloaded after any other write;
 *   - a result that reads the totals is reloaded after a totals write;
 *   - a totals write from outside the process (seen only by MySQL's stamps)
 *     reloads both.
 * Needs READ_CACHE_TEST_MYSQL=mysql://user:password@host:port (creates and
 * drops a database read_cache_groups_<pid>). Skipped without it.
 */

const URL_ENV = process.env.READ_CACHE_TEST_MYSQL;
const describeDb = URL_ENV ? describe : describe.skip;

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { watchConnection } = require('../src/services/read-cache/mysql-hook');
const { TableStamps, stampReader } = require('../src/services/read-cache/table-stamps');
const { ReadCache } = require('../src/services/read-cache/read-cache');
const { loadSchema } = require('../src/services/read-cache/schema');
const { COLUMN_GROUPS, PROJECT_TOTALS } = require('../src/services/read-cache/column-groups');

jest.setTimeout(120 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeDb('column groups on MySQL (issues/328)', () => {
  let mysql;
  let admin;
  let outside;
  let knex;
  let tracker;
  let stamps;
  let cache;
  let config;
  const database = `read_cache_groups_${process.pid}`;

  beforeAll(async () => {
    mysql = require('mysql2/promise');
    const url = new URL(URL_ENV);
    config = {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    admin = await mysql.createConnection(config);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\``);
    outside = await mysql.createConnection({ ...config, database });
    await outside.query(`CREATE TABLE projects (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50),
      dirty TINYINT(1), balance DECIMAL(10,2), total_real_hours DECIMAL(10,2))`);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (outside) await outside.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  beforeEach(async () => {
    if (knex) await knex.destroy();
    await outside.query('DELETE FROM projects');
    await outside.query("INSERT INTO projects (id, name, dirty, balance) VALUES (1, 'p1', 0, 10), (2, 'p2', 0, 20)");
    tracker = new ChangeTracker();
    tracker.setLogger({ warn: () => {} });
    tracker.setColumnGroups(COLUMN_GROUPS);
    knex = require('knex')({
      client: 'mysql2',
      connection: { ...config, database },
      pool: {
        min: 0,
        max: 4,
        afterCreate: (conn, done) => {
          watchConnection(conn, tracker);
          done(null, conn);
        },
      },
    });
    tracker.setSchema(await loadSchema(knex));
    stamps = new TableStamps({ tracker, read: stampReader(knex), intervalMs: 100 });
    cache = new ReadCache({ tracker, stamps, log: { warn: () => {}, error: () => {} } });
    cache.enable();
    stamps.watch(['projects']);
    await stamps.check();
    await sleep(2200); // past the 1 s precision of the starting stamps
    await stamps.check();
  });

  let loads;
  const names = () => {
    loads.names++;
    return knex('projects').select('id', 'name').orderBy('id');
  };
  const totals = () => {
    loads.totals++;
    return knex('projects').select('id', 'balance').orderBy('id');
  };
  const direct = async (columns) => (await outside.query(`SELECT id, ${columns} FROM projects ORDER BY id`))[0];
  const getNames = () => cache.get('names', names, { tables: ['projects'], ignoreGroups: [PROJECT_TOTALS] });
  const getTotals = () => cache.get('totals', totals, { tables: ['projects'] });
  const plain = (rows) => JSON.parse(JSON.stringify(rows));
  const check = async () => {
    expect(plain(await getNames())).toEqual(plain(await direct('name')));
    expect(plain(await getTotals())).toEqual(plain(await direct('balance')));
  };

  beforeEach(() => {
    loads = { names: 0, totals: 0 };
  });

  it('dirty and totals writes keep the names, reload the totals', async () => {
    await check();
    await knex('projects').update({ dirty: true }).where({ id: 1 });
    await knex('projects').update({ balance: 99, total_real_hours: 3, dirty: false }).where({ id: 2 });
    await check();
    expect(loads).toEqual({ names: 1, totals: 2 });
    expect(tracker.stats.groupWrites).toBe(2);
  });

  it('in a transaction too, stamped at the commit', async () => {
    await check();
    await knex.transaction(async (trx) => {
      await trx('projects').update({ dirty: true }).where({ id: 1 });
      await trx('projects').update({ balance: 5 }).where({ id: 1 });
    });
    await check();
    expect(loads).toEqual({ names: 1, totals: 2 });
  });

  it('a write of another column reloads both', async () => {
    await check();
    await knex('projects').update({ name: 'renamed', dirty: true }).where({ id: 1 });
    await check();
    expect(loads).toEqual({ names: 2, totals: 2 });
  });

  it('a totals write from outside the process reloads both, once the stamps see it', async () => {
    await check();
    await outside.query('UPDATE projects SET balance = 77 WHERE id = 1');
    await sleep(2200);
    await check();
    expect(loads).toEqual({ names: 2, totals: 2 });
  });
});
