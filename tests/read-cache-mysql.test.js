'use strict';

/**
 * issues/307 — the read cache against a real MySQL: the hook on the pool's
 * connections, the change tracker, the table stamps and the cache together.
 *
 * Every test reads through the cache, changes the data one way, and checks
 * that the next read through the cache equals a direct read of the database.
 * The ways covered are every way this backend (or someone else) writes:
 * the knex builder, raw SQL, transactions (committed, rolled back, with
 * savepoints, slow), deletes that cascade through foreign keys, a read that
 * overlaps an open transaction or a commit, and writes from a second
 * connection outside the process (another backend slot, a manual SQL repair):
 * plain, in a transaction, TRUNCATE, a dropped and re-created table.
 * The last tests run random concurrent writes and reads and compare every
 * cached answer with the database once the writes have settled.
 *
 * Needs a MySQL server: READ_CACHE_TEST_MYSQL=mysql://user:password@host:port
 * (the user creates and drops a database read_cache_test_<pid>). Skipped
 * without it.
 */

const URL_ENV = process.env.READ_CACHE_TEST_MYSQL;
const describeDb = URL_ENV ? describe : describe.skip;

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { watchConnection } = require('../src/services/read-cache/mysql-hook');
const { TableStamps, stampReader } = require('../src/services/read-cache/table-stamps');
const { ReadCache } = require('../src/services/read-cache/read-cache');
const { loadSchema } = require('../src/services/read-cache/schema');

jest.setTimeout(180 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeDb('read cache on MySQL', () => {
  let knexLib;
  let mysql;
  let admin; // unwatched connection: creates the database, plays "someone else"
  let outside; // unwatched connection to the test database: "someone else"
  let observer; // unwatched, never in a transaction: the direct reads
  let knex; // the process's pool, every connection watched
  let tracker;
  let stamps;
  let cache;
  let config;
  const database = `read_cache_test_${process.pid}`;

  beforeAll(async () => {
    knexLib = require('knex');
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
    observer = await mysql.createConnection({ ...config, database });
    await outside.query(`
      CREATE TABLE types (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))`);
    await outside.query(`
      CREATE TABLE items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))`);
    await outside.query(`
      CREATE TABLE items_type_lnk (id INT PRIMARY KEY AUTO_INCREMENT, item_id INT, type_id INT,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
        FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE CASCADE)`);
    await outside.query(`
      CREATE TABLE regions (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))`);
    await outside.query(`
      CREATE TABLE cities (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), region_id INT NULL,
        FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL)`);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (outside) await outside.end();
    if (observer) await observer.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  beforeEach(async () => {
    if (knex) await knex.destroy();
    // a failed test may have left a transaction open on it
    await outside.query('ROLLBACK');
    await outside.query('SET FOREIGN_KEY_CHECKS = 1');
    for (const t of ['items_type_lnk', 'cities', 'items', 'types', 'regions'])
      await outside.query(`DELETE FROM ${t}`);
    await outside.query("INSERT INTO types (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    await outside.query("INSERT INTO items (id, name) VALUES (1, 'x'), (2, 'y')");
    await outside.query('INSERT INTO items_type_lnk (item_id, type_id) VALUES (1, 1), (2, 2)');
    await outside.query("INSERT INTO regions (id, name) VALUES (1, 'r1'), (2, 'r2')");
    await outside.query("INSERT INTO cities (id, name, region_id) VALUES (1, 'c1', 1), (2, 'c2', 2)");

    reads = {};
    loads = {};
    tracker = new ChangeTracker();
    tracker.setLogger({ warn: () => {} });
    knex = knexLib({
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
    // let the stamps of the starting rows settle (1 s precision, see table-stamps.js)
    stamps.watch(['types', 'items', 'items_type_lnk', 'regions', 'cities']);
    await stamps.check();
  });

  // ---- what is read through the cache, and the same read straight from the db
  const LOADERS = {
    types: () => knex('types').select('id', 'name').orderBy('id'),
    itemsWithType: () =>
      knex('items as i')
        .leftJoin('items_type_lnk as l', 'l.item_id', 'i.id')
        .leftJoin('types as t', 't.id', 'l.type_id')
        .select('i.id', 'i.name', 't.name as type')
        .orderBy(['i.id', 't.name']),
    citiesWithRegion: () =>
      knex
        .raw(
          'SELECT c.id, c.name, r.name AS region FROM cities c LEFT JOIN regions r ON r.id = c.region_id ORDER BY c.id',
        )
        .then(([rows]) => rows.map((r) => ({ ...r }))),
    typeCounts: () =>
      knex('types as t')
        .leftJoin('items_type_lnk as l', 'l.type_id', 't.id')
        .groupBy('t.id')
        .select('t.id')
        .count('l.id as n')
        .orderBy('t.id'),
    // a cached result built from another cached result
    nested: async () => {
      const types = await cache.get('types', LOADERS.types);
      const [regions] = await knex.raw('SELECT name FROM regions ORDER BY id');
      return { types: types.map((t) => t.name), regions: regions.map((r) => r.name) };
    },
  };
  const KEYS = Object.keys(LOADERS);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  // reads through the cache, and loads that reached the database, per key
  let reads;
  let loads;
  const cached = (key) => {
    reads[key] = (reads[key] || 0) + 1;
    return cache
      .get(key, () => {
        loads[key] = (loads[key] || 0) + 1;
        return LOADERS[key]();
      })
      .then(plain);
  };
  // straight from the database, on the unwatched connection
  const direct = async (key) => {
    const run = async (sql) => (await observer.query(sql))[0].map((r) => ({ ...r }));
    if (key === 'types') return run('SELECT id, name FROM types ORDER BY id');
    if (key === 'itemsWithType')
      return run(
        'SELECT i.id, i.name, t.name AS type FROM items i LEFT JOIN items_type_lnk l ON l.item_id = i.id LEFT JOIN types t ON t.id = l.type_id ORDER BY i.id, t.name',
      );
    if (key === 'citiesWithRegion')
      return run(
        'SELECT c.id, c.name, r.name AS region FROM cities c LEFT JOIN regions r ON r.id = c.region_id ORDER BY c.id',
      );
    if (key === 'typeCounts')
      return (
        await run(
          'SELECT t.id, COUNT(l.id) AS n FROM types t LEFT JOIN items_type_lnk l ON l.type_id = t.id GROUP BY t.id ORDER BY t.id',
        )
      ).map((r) => ({ id: r.id, n: Number(r.n) }));
    if (key === 'nested') {
      const types = await run('SELECT name FROM types ORDER BY id');
      const regions = await run('SELECT name FROM regions ORDER BY id');
      return { types: types.map((t) => t.name), regions: regions.map((r) => r.name) };
    }
    throw new Error(key);
  };
  const normalize = (key, v) => (key === 'typeCounts' ? v.map((r) => ({ id: r.id, n: Number(r.n) })) : v);

  async function expectAllFresh() {
    for (const key of KEYS) {
      const [c, d] = [normalize(key, await cached(key)), await direct(key)];
      expect({ key, value: c }).toEqual({ key, value: d });
    }
  }

  // reads everything once so it is kept, and checks it is served from memory
  async function warm() {
    await expectAllFresh();
    // every key was kept: nothing refused for a reason other than a change
    for (const reason of Object.keys(cache.counts.notStored)) expect(reason).toBe('changed while loading');
    const hits = cache.counts.hits;
    await expectAllFresh();
    expect(cache.counts.hits).toBeGreaterThan(hits);
  }

  // the random tests mean something only if every key was served from memory
  function expectEveryKeyHit(share) {
    for (const key of KEYS) {
      const fromMemory = reads[key] - (loads[key] || 0);
      expect({ key, enough: fromMemory >= reads[key] * share }).toEqual({ key, enough: true });
    }
    for (const reason of Object.keys(cache.counts.notStored)) expect(reason).toBe('changed while loading');
  }

  describe('writes from this process', () => {
    it('serves from memory while nothing changes', async () => {
      // the starting rows were written by "someone else" in the last second:
      // their stamps are confirmed once more 2 s later, which reloads once
      await sleep(2100);
      await stamps.check();
      await warm();
      const { misses, hits } = cache.counts;
      const queries = tracker.stats.statements;
      await cached('types');
      await cached('citiesWithRegion');
      if (cache.counts.misses !== misses) {
        throw new Error(
          `reloaded: ${JSON.stringify({ counts: cache.counts, stamps: stamps.stats, seen: [...stamps.seen] })}`,
        );
      }
      expect(cache.counts.hits).toBe(hits + 2);
      // only a stamps reading may have run (at most once per interval)
      expect(tracker.stats.statements - queries).toBeLessThanOrEqual(6);
    });

    it('knex builder update', async () => {
      await warm();
      await knex('types').where({ id: 1 }).update({ name: 'a2' });
      await expectAllFresh();
    });

    it('raw SQL update, insert and delete', async () => {
      await warm();
      await knex.raw('UPDATE items SET name = ? WHERE id = ?', ['x2', 1]);
      await expectAllFresh();
      await knex.raw('INSERT INTO items_type_lnk (item_id, type_id) VALUES (?, ?)', [1, 3]);
      await expectAllFresh();
      await knex.raw('DELETE FROM items_type_lnk WHERE type_id = ?', [3]);
      await expectAllFresh();
    });

    it('a committed transaction', async () => {
      await warm();
      await knex.transaction(async (trx) => {
        const [id] = await trx('items').insert({ name: 'z' });
        await trx('items_type_lnk').insert({ item_id: id, type_id: 3 });
      });
      await expectAllFresh();
    });

    it('a rolled back transaction', async () => {
      await warm();
      await knex
        .transaction(async (trx) => {
          await trx('types').where({ id: 2 }).update({ name: 'never' });
          throw new Error('rollback');
        })
        .catch(() => {});
      await expectAllFresh();
    });

    it('savepoints: a nested transaction rolled back, the outer one committed', async () => {
      await warm();
      await knex.transaction(async (trx) => {
        await trx('types').where({ id: 1 }).update({ name: 'outer' });
        await trx
          .transaction(async (inner) => {
            await inner('types').where({ id: 2 }).update({ name: 'inner' });
            throw new Error('rollback inner');
          })
          .catch(() => {});
        await trx.transaction(async (inner) => {
          await inner('regions').where({ id: 1 }).update({ name: 'kept' });
        });
      });
      await expectAllFresh();
    });

    it('a read while another connection’s transaction is open is not served after its COMMIT', async () => {
      await warm();
      const trx = await knex.transaction();
      await trx('types').where({ id: 3 }).update({ name: 'c-new' });
      // read through the cache while the transaction is open: old data, kept
      expect((await cached('types')).find((t) => t.id === 3).name).toBe('c');
      expect((await cached('types')).find((t) => t.id === 3).name).toBe('c');
      await trx.commit();
      expect((await cached('types')).find((t) => t.id === 3).name).toBe('c-new');
      await expectAllFresh();
    });

    it('a load that overlaps a COMMIT is not kept', async () => {
      await warm();
      const trx = await knex.transaction();
      await trx('types').where({ id: 1 }).update({ name: 'during' });
      // a slow load: starts before the commit, reads after it
      const slow = cache.get('slow-types', async () => {
        await knex.raw('SELECT SLEEP(0.3)');
        return knex('types').select('id', 'name').orderBy('id');
      });
      await sleep(50);
      await trx.commit();
      const result = plain(await slow);
      expect(result.find((t) => t.id === 1).name).toBe('during');
      expect(cache.entries.has('slow-types')).toBe(false);
      await expectAllFresh();
    });

    it('a delete cascades through foreign keys (ON DELETE CASCADE)', async () => {
      await warm();
      await knex('types').where({ id: 1 }).del(); // removes items_type_lnk rows
      await expectAllFresh();
    });

    it('a delete sets child keys to NULL (ON DELETE SET NULL)', async () => {
      await warm();
      await knex.raw('DELETE FROM regions WHERE id = ?', [2]); // cities.region_id → NULL
      await expectAllFresh();
    });

    it('TRUNCATE and DDL', async () => {
      await warm();
      await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
      await knex.raw('TRUNCATE items_type_lnk');
      await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
      await expectAllFresh();
      await knex.raw('ALTER TABLE regions ADD COLUMN extra INT NULL');
      await knex.raw('ALTER TABLE regions DROP COLUMN extra');
      await expectAllFresh();
    });

    it('a read inside a transaction skips the cache', async () => {
      await warm();
      const bypassed = cache.counts.bypassed;
      cache.inTransaction = () => true;
      try {
        await cached('types');
      } finally {
        cache.inTransaction = () => false;
      }
      expect(cache.counts.bypassed).toBe(bypassed + 1);
    });

    it('a load that writes is not kept', async () => {
      await cache.get('writes', async () => {
        await knex('regions').where({ id: 1 }).update({ name: 'touched' });
        return knex('regions').select('*');
      });
      expect(cache.entries.has('writes')).toBe(false);
    });

    it('a caller changing its answer never changes what is kept', async () => {
      const first = await cache.get('types', LOADERS.types);
      first[0].name = 'mutated';
      first.push({ id: 99 });
      const second = await cache.get('types', LOADERS.types);
      second[1].name = 'mutated too';
      expect(plain(await cache.get('types', LOADERS.types))).toEqual(await direct('types'));
    });
  });

  describe('writes from outside the process (second connection)', () => {
    // detection needs a stamps reading after the change; writes in the same
    // second as a reading are confirmed 2 s later (1 s precision)
    async function expectFreshWithin(ms) {
      const until = Date.now() + ms;
      for (;;) {
        let ok = true;
        for (const key of KEYS) {
          const c = normalize(key, await cached(key));
          if (JSON.stringify(c) !== JSON.stringify(await direct(key))) ok = false;
        }
        if (ok) return;
        if (Date.now() > until) {
          await expectAllFresh(); // fails with the diff
          return;
        }
        await sleep(100);
      }
    }

    it('a plain update is noticed within a few seconds', async () => {
      await warm();
      await outside.query("UPDATE types SET name = 'outside' WHERE id = 2");
      const t0 = Date.now();
      await expectFreshWithin(4000);
      expect(Date.now() - t0).toBeLessThan(4000);
    });

    it('a second write in the same second as the first is noticed too', async () => {
      await warm();
      await outside.query("UPDATE types SET name = 'one' WHERE id = 1");
      await sleep(150); // a stamps reading sees the first write...
      await cached('types');
      await outside.query("UPDATE types SET name = 'two' WHERE id = 1"); // ...maybe in the same second
      await expectFreshWithin(4000);
    });

    it('a transaction committed later is noticed after its commit', async () => {
      await warm();
      await outside.query('BEGIN');
      await outside.query("UPDATE regions SET name = 'r1-outside' WHERE id = 1");
      await sleep(300);
      await expectAllFresh(); // not committed: the old data is right
      await outside.query('COMMIT');
      await expectFreshWithin(4000);
    });

    it('a cascade from outside', async () => {
      await warm();
      await outside.query('DELETE FROM items WHERE id = 1');
      await expectFreshWithin(4000);
    });

    it('TRUNCATE from outside (the stamp goes back to NULL)', async () => {
      await warm();
      await outside.query('SET FOREIGN_KEY_CHECKS = 0');
      await outside.query('TRUNCATE items_type_lnk');
      await outside.query('SET FOREIGN_KEY_CHECKS = 1');
      await expectFreshWithin(4000);
    });

    it('a table dropped and re-created (a restore)', async () => {
      await warm();
      await outside.query('SET FOREIGN_KEY_CHECKS = 0');
      await outside.query('DROP TABLE cities');
      await outside.query(`CREATE TABLE cities (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), region_id INT NULL,
        FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL)`);
      await outside.query("INSERT INTO cities (id, name, region_id) VALUES (1, 'restored', 2)");
      await outside.query('SET FOREIGN_KEY_CHECKS = 1');
      await expectFreshWithin(4000);
    });
  });

  describe('random concurrent writes and reads', () => {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    let opsLog = [];
    const rnd = (n) => 1 + Math.floor(Math.random() * n);

    // each returns a promise; all write through the process's pool
    const OPS = [
      () =>
        knex('types')
          .where({ id: rnd(4) })
          .update({ name: `t${rnd(99)}` }),
      () => knex.raw('UPDATE items SET name = ? WHERE id = ?', [`i${rnd(99)}`, rnd(4)]),
      () =>
        knex
          .transaction(async (trx) => {
            const [id] = await trx('items').insert({ name: `n${rnd(99)}` });
            await sleep(rnd(30));
            await trx('items_type_lnk').insert({ item_id: id, type_id: rnd(3) });
          })
          .catch(() => {}),
      () =>
        knex('items_type_lnk')
          .where({ type_id: rnd(4) })
          .del(),
      () => knex.raw('INSERT INTO types (name) VALUES (?)', [`new${rnd(99)}`]),
      () => knex('types').where('id', '>', 3).orderBy('id').limit(1).del(), // cascades
      () =>
        knex('regions')
          .where({ id: rnd(3) })
          .update({ name: `r${rnd(99)}` }),
      () => knex.raw('INSERT INTO regions (name) VALUES (?)', [`nr${rnd(99)}`]),
      () => knex('regions').where('id', '>', 2).orderBy('id').limit(1).del(), // sets cities.region_id NULL
      () => knex.raw('UPDATE cities SET region_id = (SELECT MAX(id) FROM regions) WHERE id = ?', [rnd(2)]),
      () =>
        knex
          .transaction(async (trx) => {
            await trx('types')
              .where({ id: rnd(3) })
              .update({ name: 'rolled back' });
            await sleep(rnd(30));
            throw new Error('rollback');
          })
          .catch(() => {}),
      () =>
        knex.transaction(async (trx) => {
          await trx('types')
            .where({ id: rnd(3) })
            .update({ name: `sp${rnd(99)}` });
          await trx.transaction(async (inner) =>
            inner('regions')
              .where({ id: rnd(2) })
              .update({ name: `spr${rnd(99)}` }),
          );
          await sleep(rnd(40));
        }),
    ];

    async function round({ writers, readers }) {
      const reads = Array.from({ length: readers }, async () => {
        for (let i = 0; i < 6; i++) {
          await cached(pick(KEYS));
          await sleep(rnd(15));
        }
      });
      const writes = Array.from({ length: writers }, async () => {
        await sleep(rnd(20));
        const index = OPS.indexOf(pick(OPS));
        opsLog.push(`start op${index} @${tracker.now()}`);
        // a deadlock or a refused write is one more case the cache must survive
        const error = await Promise.resolve(OPS[index]()).then(
          () => null,
          (e) => e,
        );
        opsLog.push(
          `end op${index} @${tracker.now()}${error ? ` failed: ${error.code || error.message}` : ''}`,
        );
      });
      await Promise.all([...reads, ...writes]);
    }

    // on a difference, show what the round did
    async function checkRound(r) {
      try {
        await expectAllFresh();
      } catch (error) {
        const entries = [...cache.entries.values()].map(
          (e) => `${e.key} started@${e.started} seq${e.stampSeq} [${e.tables}]`,
        );
        error.message += `\nround ${r}\n${opsLog.join('\n')}\nentries:\n${entries.join('\n')}\ncounts ${JSON.stringify(cache.counts)}`;
        throw error;
      }
      opsLog = [];
    }

    it('cached answers equal the database after every round (in-process writes)', async () => {
      await warm();
      for (let r = 0; r < 60; r++) {
        await round({ writers: 1 + rnd(3), readers: 4 });
        await checkRound(r);
      }
      // the test is only meaningful if the cache was used, for every key
      expectEveryKeyHit(0.2);
    });

    it('with writes from outside too', async () => {
      await warm();
      for (let r = 0; r < 4; r++) {
        await round({ writers: 2, readers: 3 });
        await outside.query('UPDATE types SET name = ? WHERE id = ?', [`out${r}`, rnd(3)]);
        await round({ writers: 1, readers: 3 });
        // outside writes need a stamps reading (and the 2 s recheck)
        await sleep(2600);
        await cached('types'); // triggers the reading
        await sleep(150);
        await expectAllFresh();
      }
      expectEveryKeyHit(0.1);
    });
  });
});
