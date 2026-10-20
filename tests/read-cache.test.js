'use strict';

/**
 * issues/307 — the read cache: `get(key, loader, { tables })` answers from
 * memory while nothing it depends on changed. These tests drive the change
 * tracker directly (as the MySQL hook would) and check what the cache does
 * with it; read-cache-mysql.test.js runs the same against a real database.
 * What must hold:
 *   - a kept answer is served until one of its tables changes; the tables are
 *     the declared ones plus the ones its load read;
 *   - an answer whose tables changed while loading is returned but not kept;
 *   - a load that writes, reads no known table, or depends on no table is not
 *     kept; neither is an answer refused by `keep`, one that can't be copied,
 *     or one bigger than a quarter of the cap;
 *   - callers never share objects with the cache;
 *   - loads of the same key at the same time are shared only when nothing
 *     changed meanwhile;
 *   - inside a transaction, when off, or when detection failed, the cache is
 *     skipped; when the stamps can't be read, the database answers;
 *   - memory is capped (least recently used out) and answers expire;
 *   - a sampled hit is loaded again; a difference no change explains is
 *     logged as an error and the entry dropped.
 */

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { ReadCache } = require('../src/services/read-cache/read-cache');

let tracker;
let cache;
let now;
let log;

const TABLES = ['cities', 'regions', 'cities_region_lnk', 'project_types', 'up_permissions'];

beforeEach(() => {
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema({ tables: TABLES });
  now = 0;
  log = { warn: jest.fn(), error: jest.fn() };
  cache = new ReadCache({ tracker, clock: () => now, log });
  cache.enable();
});

// what the hook reports for a statement on a connection
const sql = (statement, conn = 'c1') =>
  tracker.statementEnded(conn, tracker.statementStarted(conn, statement));
// a statement of another request, not part of the load running now
const elsewhere = (statement) => tracker.capture.exit(() => sql(statement, 'c2'));

// a loader that reads tables through the "database" and returns rows
function loaderOf(tables, value = () => ({ rows: [1, 2] })) {
  const fn = jest.fn(async () => {
    for (const t of tables) sql(`select * from \`${t}\``);
    await Promise.resolve();
    return value();
  });
  return fn;
}

describe('ReadCache.get', () => {
  it('loads once and then answers from memory', async () => {
    const load = loaderOf(['cities']);
    expect(await cache.get('k', load)).toEqual({ rows: [1, 2] });
    expect(await cache.get('k', load)).toEqual({ rows: [1, 2] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.counts.hits).toBe(1);
  });

  it('a write to a table the load read makes it load again', async () => {
    const load = loaderOf(['cities', 'cities_region_lnk']);
    await cache.get('k', load);
    sql('update `cities_region_lnk` set region_id = 1');
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a write to a declared table makes it load again', async () => {
    const load = loaderOf(['cities']);
    await cache.get('k', load, { tables: ['UP_PERMISSIONS'] });
    sql('delete from `up_permissions` where id = 1');
    await cache.get('k', load, { tables: ['up_permissions'] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the check on read alone (without freeing entries on change) keeps answers fresh', async () => {
    cache.unsubscribe(); // no eager drop
    const load = loaderOf(['cities']);
    await cache.get('k', load);
    sql('update `cities` set x = 1');
    expect(cache.entries.size).toBe(1); // still there...
    await cache.get('k', load); // ...but not served
    expect(load).toHaveBeenCalledTimes(2);
    tracker.everythingChanged('test');
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a write elsewhere leaves it alone', async () => {
    const load = loaderOf(['cities']);
    await cache.get('k', load);
    sql('update `project_types` set name = 1');
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('an answer whose table changed while loading is returned, not kept', async () => {
    const load = jest.fn(async () => {
      sql('select * from `cities`');
      elsewhere('update `cities` set name = 1'); // someone else, meanwhile
      return 'old or new';
    });
    expect(await cache.get('k', load)).toBe('old or new');
    expect(cache.entries.size).toBe(0);
    expect(cache.counts.notStored['changed while loading']).toBe(1);
  });

  it.each([
    ['writes', async () => sql('update `cities` set x = 1') || 'x', 'the load writes'],
    ['reads no known table', async () => sql('select 1') || 'x', 'read of no known table'],
    ['depends on no table', async () => 'x', 'no tables'],
  ])('a load that %s is not kept', async (_label, load, reason) => {
    await cache.get('k', load);
    expect(cache.entries.size).toBe(0);
    expect(Object.keys(cache.counts.notStored)).toEqual([reason]);
  });

  it('a declared table this database does not have keeps nothing (and warns)', async () => {
    await cache.get('k', loaderOf(['cities']), { tables: ['not_a_table'] });
    expect(cache.entries.size).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not_a_table'));
  });

  it('keep() can refuse an answer', async () => {
    await cache.get('k', loaderOf(['cities']), { keep: () => false });
    expect(cache.entries.size).toBe(0);
  });

  it('an answer that cannot be copied is not kept', async () => {
    await cache.get(
      'k',
      loaderOf(['cities'], () => ({ fn: () => 1 })),
    );
    expect(cache.entries.size).toBe(0);
    expect(cache.counts.notStored['not copyable']).toBe(1);
  });

  it('a failed load is not kept, and the error reaches the caller', async () => {
    const load = jest.fn(async () => {
      sql('select * from `cities`');
      throw new Error('db error');
    });
    await expect(cache.get('k', load)).rejects.toThrow('db error');
    expect(cache.entries.size).toBe(0);
    await expect(cache.get('k', load)).rejects.toThrow('db error');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('callers never share objects with the cache', async () => {
    const load = loaderOf(['cities'], () => ({ rows: [{ name: 'a' }] }));
    const first = await cache.get('k', load);
    first.rows[0].name = 'changed by the first caller';
    const second = await cache.get('k', load);
    expect(second).toEqual({ rows: [{ name: 'a' }] });
    second.rows.push('changed by the second');
    expect(await cache.get('k', load)).toEqual({ rows: [{ name: 'a' }] });
  });

  it('keys are separate', async () => {
    await cache.get(
      'a',
      loaderOf(['cities'], () => 'A'),
    );
    await cache.get(
      'b',
      loaderOf(['cities'], () => 'B'),
    );
    expect(await cache.get('a', loaderOf(['cities']))).toBe('A');
    expect(await cache.get('b', loaderOf(['cities']))).toBe('B');
  });

  describe('loads at the same time', () => {
    it('share one load', async () => {
      const load = loaderOf(['cities']);
      const answers = await Promise.all([cache.get('k', load), cache.get('k', load), cache.get('k', load)]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([{ rows: [1, 2] }, { rows: [1, 2] }, { rows: [1, 2] }]);
      // each its own object
      expect(answers[0]).not.toBe(answers[1]);
      expect(answers[1]).not.toBe(answers[2]);
      expect(cache.counts.shared).toBe(2);
    });

    it('a waiter does not get what the first caller changed', async () => {
      const load = loaderOf(['cities'], () => ({ rows: ['clean'] }));
      const first = cache.get('k', load).then((a) => {
        a.rows[0] = 'changed by the first caller';
        return a;
      });
      const second = cache.get('k', load);
      await first;
      expect(await second).toEqual({ rows: ['clean'] });
    });

    it('do not share a load whose tables changed while it ran', async () => {
      let n = 0;
      const load = jest.fn(async () => {
        n += 1;
        sql('select * from `cities`');
        if (n === 1) elsewhere('update `cities` set x = 1');
        await Promise.resolve();
        return n;
      });
      const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
      expect(a).toBe(1);
      expect(b).toBe(2); // loaded for itself
    });
  });

  describe('when the cache must be skipped', () => {
    it('inside a transaction', async () => {
      cache.inTransaction = () => true;
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(cache.entries.size).toBe(0);
    });

    it('when off', async () => {
      cache.disable();
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('when change detection failed, even with answers kept', async () => {
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      tracker.fail(new Error('hook broke'));
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(cache.isOn()).toBe(false);
    });

    it('when the stamps cannot be read: the database answers', async () => {
      cache.stamps = {
        fresh: async () => Promise.reject(new Error('stamps down')),
        completed: () => 0,
        watch() {},
      };
      cache.stamps.coveredSince = () => true;
      const load = loaderOf(['cities']);
      await cache.get('k', load); // miss: loads (stamps are read only to serve)
      expect(await cache.get('k', load)).toEqual({ rows: [1, 2] });
      expect(load).toHaveBeenCalledTimes(2);
      expect(cache.counts.stampFailures).toBe(1);
    });

    it('when the stamps had not read a table before the load began', async () => {
      let covered = false;
      cache.stamps = { fresh: async () => {}, completed: () => 0, watch() {}, coveredSince: () => covered };
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
      covered = true;
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('when the stamps reading reports a change', async () => {
      cache.stamps = {
        fresh: async () => tracker.externalChange(['cities']),
        completed: () => 0,
        watch() {},
        coveredSince: () => true,
      };
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('memory and time', () => {
    it('answers expire', async () => {
      cache.ttlMs = 1000;
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      now = 999;
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(1);
      now = 1000;
      await cache.get('k', load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(cache.counts.invalid.expired).toBe(1);
    });

    it('a ttl per call', async () => {
      const load = loaderOf(['cities']);
      await cache.get('k', load, { ttlMs: 10 });
      now = 10;
      await cache.get('k', load, { ttlMs: 10 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('the least recently used answers go first past the cap', async () => {
      const big = () => ({ text: 'x'.repeat(300) });
      cache.maxBytes = 1300; // room for 4 answers of ~314 bytes
      for (const k of ['a', 'b', 'c', 'd']) await cache.get(k, loaderOf(['cities'], big));
      await cache.get('a', loaderOf(['cities'], big)); // a is used again
      await cache.get('e', loaderOf(['cities'], big)); // b goes
      expect([...cache.entries.keys()]).toEqual(['c', 'd', 'a', 'e']);
      expect(cache.bytes).toBeLessThanOrEqual(1300);
      expect(cache.counts.evicted).toBe(1);
    });

    it('an answer bigger than a quarter of the cap is not kept', async () => {
      cache.maxBytes = 1000;
      await cache.get(
        'k',
        loaderOf(['cities'], () => 'y'.repeat(300)),
      );
      expect(cache.entries.size).toBe(0);
      expect(cache.counts.notStored['too big']).toBe(1);
    });

    it('a change frees the entries it made stale at once', async () => {
      await cache.get('a', loaderOf(['cities']));
      await cache.get('b', loaderOf(['regions']));
      sql('update `cities` set x = 1');
      expect([...cache.entries.keys()]).toEqual(['b']);
      expect(cache.bytes).toBe(cache.entries.get('b').bytes);
    });

    it('clear() drops everything, and a load in progress is not kept', async () => {
      await cache.get('a', loaderOf(['cities']));
      const slow = cache.get('b', async () => {
        sql('select * from `regions`');
        await new Promise((r) => setTimeout(r, 5));
        return 'b';
      });
      cache.clear();
      await slow;
      expect(cache.entries.size).toBe(0);
    });
  });

  describe('nested answers', () => {
    it('an answer built on a kept answer depends on its tables too', async () => {
      const inner = loaderOf(['cities'], () => ['c']);
      const outer = jest.fn(async () => {
        const cities = await cache.get('inner', inner);
        sql('select * from `regions`');
        return { cities };
      });
      await cache.get('inner', inner); // kept first: the outer load hits it
      await cache.get('outer', outer);
      expect(cache.entries.get('outer').tables.sort()).toEqual(['cities', 'regions']);
      sql('update `cities` set x = 1');
      await cache.get('outer', outer);
      expect(outer).toHaveBeenCalledTimes(2);
    });

    it('an outer load is not kept if an inner one wrote', async () => {
      const outer = async () => {
        await cache.get('inner', async () => {
          sql('select * from `cities`');
          sql('update `regions` set x = 1');
          return 1;
        });
        sql('select * from `project_types`');
        return 2;
      };
      await cache.get('outer', outer);
      expect(cache.entries.has('outer')).toBe(false);
    });
  });

  describe('verification of sampled hits', () => {
    it('a difference no change explains is logged as an error and dropped', async () => {
      cache.verifyRate = 1;
      cache.random = () => 0;
      let value = 'a';
      const load = loaderOf(['cities'], () => value);
      await cache.get('k', load);
      value = 'b'; // the database changed without any statement we saw
      expect(await cache.get('k', load)).toBe('b');
      expect(cache.counts.mismatches).toBe(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('STALE'));
      expect(cache.entries.has('k')).toBe(false);
    });

    it('the same answer is fine', async () => {
      cache.verifyRate = 1;
      cache.random = () => 0;
      const load = loaderOf(['cities']);
      await cache.get('k', load);
      await cache.get('k', load);
      expect(cache.counts.verified).toBe(1);
      expect(cache.counts.mismatches).toBe(0);
      expect(cache.entries.has('k')).toBe(true);
    });

    it('a difference explained by a change during the check is not an error', async () => {
      cache.verifyRate = 1;
      cache.random = () => 0;
      let n = 0;
      const load = jest.fn(async () => {
        sql('select * from `cities`');
        n += 1;
        if (n === 2) elsewhere('update `cities` set x = 1');
        return n;
      });
      await cache.get('k', load);
      await cache.get('k', load);
      expect(cache.counts.mismatches).toBe(0);
    });
  });

  it('stats() describes the cache', async () => {
    await cache.get('k', loaderOf(['cities']));
    await cache.get('k', loaderOf(['cities']));
    expect(cache.stats()).toMatchObject({ on: true, entries: 1, hits: 1, misses: 1, stored: 1 });
  });
});
