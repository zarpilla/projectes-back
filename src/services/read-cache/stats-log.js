'use strict';

/**
 * One log line of the read cache's figures, every hour (issues/328).
 *
 * The figures (`/api/read-cache/stats`) live in the process, are only shown to
 * app admins and restart with every deploy, so they could not be followed in
 * production. Each backend now logs them to Loki as
 * `[read-cache] stats {json}`: counters since the start, memory, and the
 * reports that cost the most loading time. In Grafana:
 *   {job="strapi"} |= "[read-cache] stats" | regexp `stats (?P<j>.*)` | line_format "{{.j}}" | json
 */

const { processMemory } = require('./memory');

const MB = 1024 * 1024;
const TOP_REPORTS = 12;

/** The figures as one compact object (keys short: one line per hour and tenant). */
function statsSummary(stats, memory) {
  const reports = Object.entries(stats.reports || {})
    .map(([name, f]) => [
      name,
      {
        hits: f.hits + f.shared,
        loads: f.firstLoads + f.loadsAgain,
        again: f.loadsAgain,
        loadMs: f.loadMsTotal,
        maxMs: f.loadMsMax,
      },
    ])
    .sort((a, b) => b[1].loadMs - a[1].loadMs)
    .slice(0, TOP_REPORTS);
  return {
    since: stats.since,
    on: stats.on,
    entries: stats.entries,
    keptMB: Math.round((stats.bytes / MB) * 10) / 10,
    capMB: Math.round(stats.maxBytes / MB),
    hits: stats.hits,
    shared: stats.shared,
    misses: stats.misses,
    bypassed: stats.bypassed,
    dropped: stats.dropped,
    evicted: stats.evicted,
    verified: stats.verified,
    mismatches: stats.mismatches,
    late: stats.late,
    invalid: stats.invalid,
    notStored: stats.notStored,
    writes: stats.tracker && stats.tracker.writes,
    everything: stats.tracker && stats.tracker.everything,
    memory,
    reports: Object.fromEntries(reports),
  };
}

/** Logs the figures every `everyMs` (0: never). Returns the stop function. */
function startStatsLog(cache, log, { everyMs = 60 * 60 * 1000, memory = processMemory } = {}) {
  if (!everyMs || everyMs <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      log.info(`[read-cache] stats ${JSON.stringify(statsSummary(cache.stats(), memory()))}`);
    } catch (error) {
      log.warn(`[read-cache] stats line failed: ${error && error.message}`);
    }
  }, everyMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { statsSummary, startStatsLog };
