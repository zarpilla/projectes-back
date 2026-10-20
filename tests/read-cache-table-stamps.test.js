'use strict';

/**
 * issues/307 — writes from outside the process (the other backend slot during
 * a deploy, a manual SQL repair, a restore) are noticed through MySQL's
 * per-table commit time (information_schema.TABLES.UPDATE_TIME). What must
 * hold, given how MySQL keeps that stamp (measured on 8.4, see
 * table-stamps.js):
 *   - a stamp that moves, or goes back to NULL (TRUNCATE, ALTER, eviction),
 *     or a table re-created (CREATE_TIME) or gone, is a change;
 *   - a stamp read in the same second as a write could hide a second write
 *     in that second: it is reported once more on the first reading 2 s on;
 *   - a MySQL restart is a change of everything;
 *   - a result is trusted only if its tables were read before its load began;
 *   - readings are shared and spaced by the interval; a failed reading is
 *     reported, and the next request tries again.
 */

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { TableStamps } = require('../src/services/read-cache/table-stamps');

let tracker;
let answer; // what the next reading returns
let readings;
let now; // the clock of the Node process (ms)

function make(intervalMs = 2000) {
  return new TableStamps({
    tracker,
    intervalMs,
    clock: () => now,
    read: async (tables) => {
      readings.push(tables);
      if (answer instanceof Error) throw answer;
      return {
        now: answer.now,
        started: answer.started,
        rows: answer.rows.filter((r) => tables.includes(r.table)),
      };
    },
  });
}

beforeEach(() => {
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema({
    tables: ['cities', 'regions', 'projects', 'projects_cmps'],
    foreignKeys: [{ table: 'projects_cmps', referencedTable: 'projects', deleteRule: 'CASCADE' }],
  });
  readings = [];
  now = 1_000_000;
  answer = {
    now: 5000,
    started: 100,
    rows: [
      { table: 'cities', updated: 4000, created: 10 },
      { table: 'regions', updated: null, created: 10 },
      { table: 'projects', updated: 4500, created: 10 },
    ],
  };
});

const changedAfter = (stamps, fn) => {
  const at = tracker.now();
  return Promise.resolve(fn()).then(() => (t) => tracker.changedSince([t], at));
};

describe('TableStamps', () => {
  it('the first reading sets the starting point: no change', async () => {
    const stamps = make();
    stamps.watch(['cities', 'regions']);
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(false);
    expect(changed('regions')).toBe(false);
  });

  it('a stamp that moves is a change of that table only', async () => {
    const stamps = make();
    stamps.watch(['cities', 'regions']);
    await stamps.check();
    answer.rows[0] = { table: 'cities', updated: 4100, created: 10 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
    expect(changed('regions')).toBe(false);
  });

  it('going back to NULL (TRUNCATE, ALTER, eviction) is a change', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    await stamps.check();
    answer.rows[0] = { table: 'cities', updated: null, created: 10 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
  });

  it('NULL to a value is a change', async () => {
    const stamps = make();
    stamps.watch(['regions']);
    await stamps.check();
    answer.rows[1] = { table: 'regions', updated: 4999, created: 10 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('regions')).toBe(true);
  });

  it('a re-created table (CREATE_TIME moved) is a change, even with the same stamp', async () => {
    const stamps = make();
    stamps.watch(['regions']);
    await stamps.check();
    answer.rows[1] = { table: 'regions', updated: null, created: 4990 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('regions')).toBe(true);
  });

  it('a table that disappears is a change', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    await stamps.check();
    answer.rows = answer.rows.filter((r) => r.table !== 'cities');
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
  });

  it('a change follows the foreign key cascades', async () => {
    const stamps = make();
    stamps.watch(['projects']);
    await stamps.check();
    answer.rows[2] = { table: 'projects', updated: 4600, created: 10 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('projects_cmps')).toBe(true);
  });

  it('a stamp from the second of the reading is reported once more 2 s later', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    answer.rows[0] = { table: 'cities', updated: 5000, created: 10 }; // written this second
    await stamps.check();
    // 1 s later, unchanged: still within the uncertain window
    answer.now = 5001;
    let changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(false);
    // 2 s after the stamp: reported once
    answer.now = 5002;
    changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
    // and only once
    answer.now = 5010;
    changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(false);
  });

  it('a stamp from the second before the reading is uncertain too', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    answer.rows[0] = { table: 'cities', updated: 4999, created: 10 };
    await stamps.check();
    answer.now = 5001;
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
  });

  it('a stamp that moves to a recent second is confirmed again later', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    await stamps.check();
    answer.rows[0] = { table: 'cities', updated: 5000, created: 10 };
    let changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
    answer.now = 5003;
    changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(true);
  });

  it('a MySQL restart is a change of everything, and starts over', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    await stamps.check();
    const seqBefore = stamps.completed();
    answer.started = 4900; // the server started again
    answer.rows[0] = { table: 'cities', updated: null, created: 10 };
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('regions')).toBe(true);
    expect(stamps.stats.restarts).toBe(1);
    // what was loaded before the restart is not covered any more
    expect(stamps.coveredSince(['cities'], seqBefore)).toBe(false);
  });

  it('a second of jitter in the server start time is not a restart', async () => {
    const stamps = make();
    stamps.watch(['cities']);
    await stamps.check();
    answer.started = 101;
    const changed = await changedAfter(stamps, () => stamps.check());
    expect(changed('cities')).toBe(false);
    expect(stamps.stats.restarts).toBe(0);
  });

  it('coveredSince: only tables read by that reading or before', async () => {
    const stamps = make();
    expect(stamps.coveredSince(['cities'], stamps.completed())).toBe(false);
    stamps.watch(['cities']);
    await stamps.check();
    const seq = stamps.completed();
    expect(stamps.coveredSince(['cities'], seq)).toBe(true);
    expect(stamps.coveredSince(['cities'], seq - 1)).toBe(false);
    stamps.watch(['regions']);
    expect(stamps.coveredSince(['cities', 'regions'], seq)).toBe(false);
    await stamps.check();
    expect(stamps.coveredSince(['cities', 'regions'], seq)).toBe(false); // read after that load began
    expect(stamps.coveredSince(['cities', 'regions'], stamps.completed())).toBe(true);
    // a change keeps the coverage (it is reported as a change instead)
    answer.rows[0] = { table: 'cities', updated: 4321, created: 10 };
    await stamps.check();
    expect(stamps.coveredSince(['cities'], seq)).toBe(true);
  });

  describe('fresh()', () => {
    it('reads once per interval, shared by callers', async () => {
      const stamps = make(2000);
      stamps.watch(['cities']);
      await Promise.all([stamps.fresh(), stamps.fresh(), stamps.fresh()]);
      expect(readings).toHaveLength(1);
      now += 1000;
      await stamps.fresh();
      expect(readings).toHaveLength(1);
      now += 1500;
      await stamps.fresh();
      expect(readings).toHaveLength(2);
    });

    it('a newly watched table is read at once', async () => {
      const stamps = make(2000);
      stamps.watch(['cities']);
      await stamps.fresh();
      stamps.watch(['regions']);
      await stamps.fresh();
      expect(readings).toEqual([['cities'], ['cities', 'regions']]);
      stamps.watch(['regions']); // already watched
      await stamps.fresh();
      expect(readings).toHaveLength(2);
    });

    it('a failed reading rejects, and the next call tries again', async () => {
      const stamps = make(2000);
      stamps.watch(['cities']);
      answer = new Error('db down');
      await expect(stamps.fresh()).rejects.toThrow('db down');
      expect(stamps.stats.failures).toBe(1);
      answer = { now: 5000, started: 100, rows: [{ table: 'cities', updated: 4000, created: 10 }] };
      await stamps.fresh();
      expect(readings).toHaveLength(2);
    });
  });
});
