'use strict';

/**
 * issues/328 — the read cache's figures could not be followed in production:
 * they live in the process, are shown to app admins only and restart with
 * every deploy. Each backend now logs them every hour as one line,
 * `[read-cache] stats {json}`, for Loki.
 */

const { statsSummary, startStatsLog } = require('../src/services/read-cache/stats-log');

const STATS = {
  since: '2026-10-23T05:00:00.000Z',
  on: true,
  entries: 40,
  bytes: 12.34 * 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
  hits: 900,
  shared: 3,
  misses: 120,
  bypassed: 7,
  dropped: 30,
  evicted: 2,
  verified: 45,
  mismatches: 0,
  late: 0,
  invalid: { changed: 25 },
  notStored: { 'changed while loading': 1 },
  tracker: { writes: 500, everything: 1 },
  reports: {
    'treasury.forecast': { hits: 80, shared: 1, firstLoads: 10, loadsAgain: 6, loadMsTotal: 30000, loadMsMax: 5000 },
    'GET /years': { hits: 300, shared: 0, firstLoads: 1, loadsAgain: 0, loadMsTotal: 20, loadMsMax: 20 },
    'project.economic-detail': { hits: 10, shared: 0, firstLoads: 2, loadsAgain: 1, loadMsTotal: 9000, loadMsMax: 4000 },
  },
};

describe('read-cache stats line', () => {
  it('summarises counters, memory and the costliest reports first', () => {
    const s = statsSummary(STATS, { rssMB: 500 });
    expect(s).toMatchObject({ entries: 40, keptMB: 12.3, capMB: 64, hits: 900, misses: 120, evicted: 2, writes: 500 });
    expect(s.memory).toEqual({ rssMB: 500 });
    expect(Object.keys(s.reports)).toEqual(['treasury.forecast', 'project.economic-detail', 'GET /years']);
    expect(s.reports['treasury.forecast']).toEqual({ hits: 81, loads: 16, again: 6, loadMs: 30000, maxMs: 5000 });
  });

  it('logs it every period as one JSON line, and stops', () => {
    jest.useFakeTimers();
    const log = { info: jest.fn(), warn: jest.fn() };
    const stop = startStatsLog({ stats: () => STATS }, log, { everyMs: 1000, memory: () => ({ rssMB: 1 }) });
    jest.advanceTimersByTime(2500);
    expect(log.info).toHaveBeenCalledTimes(2);
    const [line] = log.info.mock.calls[0];
    expect(line.startsWith('[read-cache] stats {')).toBe(true);
    expect(JSON.parse(line.slice('[read-cache] stats '.length)).hits).toBe(900);
    stop();
    jest.advanceTimersByTime(5000);
    expect(log.info).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('0 means never; a failure warns instead of throwing', () => {
    jest.useFakeTimers();
    const log = { info: jest.fn(), warn: jest.fn() };
    startStatsLog({ stats: () => STATS }, log, { everyMs: 0 });
    const stop = startStatsLog({ stats: () => { throw new Error('boom'); } }, log, { everyMs: 10 });
    jest.advanceTimersByTime(15);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    stop();
    jest.useRealTimers();
  });
});
