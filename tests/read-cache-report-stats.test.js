'use strict';

/**
 * issues/307 (2026-10-21): before deciding whether to warm the cache, measure
 * what each report costs its users: answers from memory, and the loads they
 * waited for, the first since the start (a deploy) apart from the loads again
 * (after a change, the TTL or the cap). A slow load is logged, to follow it
 * across tenants in the logs.
 */

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { ReadCache, familyOf } = require('../src/services/read-cache/read-cache');

let tracker;
let cache;
let now;
let log;

beforeEach(() => {
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema({ tables: ['projects', 'cities'] });
  now = 1_000_000;
  log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  cache = new ReadCache({ tracker, clock: () => now, log, slowLoadMs: 1000 });
  cache.enable();
});

const sql = (statement, conn = 'c1') => tracker.statementEnded(conn, tracker.statementStarted(conn, statement));

// a load that reads `table` and takes `ms` on the cache's clock
const loader = (table, ms) => async () => {
  sql(`select * from \`${table}\``);
  now += ms;
  await Promise.resolve();
  return { rows: [1] };
};

describe('per-report figures', () => {
  it('names the report of a key', () => {
    expect(familyOf('treasury.forecast:projects')).toBe('treasury.forecast');
    expect(familyOf('project.economic-detail:2026')).toBe('project.economic-detail');
    expect(familyOf('route|GET /projects/dedications|project.findDedications|role:1|{}|{}|day:2026-10-21')).toBe(
      'GET /projects/dedications',
    );
    expect(familyOf('calendars:festives')).toBe('calendars');
  });

  it('counts answers from memory, first loads and loads again, with their time', async () => {
    await cache.get('project.economic-detail:2026', loader('projects', 1200));
    await cache.get('project.economic-detail:2026', loader('projects', 1200));
    await cache.get('project.economic-detail:2026', loader('projects', 1200));
    // a project saved: the next one waits again
    sql('update `projects` set name = ?');
    await cache.get('project.economic-detail:2026', loader('projects', 800));

    const figures = cache.stats().reports['project.economic-detail'];
    expect(figures).toMatchObject({
      hits: 2,
      firstLoads: 1,
      loadsAgain: 1,
      loadMsTotal: 2000,
      loadMsMax: 1200,
      lastLoadMs: 800,
      lastLoadAt: new Date(now).toISOString(),
    });
  });

  it('keeps each report apart, and the pieces of one together', async () => {
    await cache.get('treasury.forecast:projects', loader('projects', 300));
    await cache.get('treasury.forecast:emitted', loader('projects', 200));
    await cache.get('route|GET /cities|api::city.city.find|role:1|{}|{}', loader('cities', 10));

    const { reports } = cache.stats();
    expect(reports['treasury.forecast']).toMatchObject({ firstLoads: 2, loadMsTotal: 500, loadMsMax: 300 });
    expect(reports['GET /cities']).toMatchObject({ firstLoads: 1, loadMsTotal: 10 });
  });

  it('logs a slow load, not a quick one', async () => {
    await cache.get('treasury.forecast:projects', loader('projects', 999));
    expect(log.info).not.toHaveBeenCalled();
    await cache.get('project.economic-detail:2026', loader('projects', 6800));
    expect(log.info).toHaveBeenCalledWith('[read-cache] slow load: project.economic-detail 6800 ms (first since start)');
    sql('update `projects` set name = ?');
    await cache.get('project.economic-detail:2026', loader('projects', 7000));
    expect(log.info).toHaveBeenLastCalledWith('[read-cache] slow load: project.economic-detail 7000 ms (again)');
  });

  it('says since when it counts', () => {
    expect(cache.stats().since).toBe(new Date(1_000_000).toISOString());
  });
});
