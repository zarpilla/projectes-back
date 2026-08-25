/**
 * v5 cron tasks. Ported from v3 config/functions/cron.js.
 *
 * v5 shape: each task is { schedule, task: ({ strapi }) => async (name) => {} } or a
 * bare function. The 3 jobs reference controllers/services that are ported in Phase 4
 * (task.email) and Phase 5/8 (FACe check-status / retry-pending). Until then they run
 * as safe no-op stubs so the scheduler is verified end-to-end.
 *
 * Once the real handlers exist, replace the stub bodies with:
 *   task.email          -> strapi.service('api::task.task').email()
 *   face check-status   -> strapi.service('api::face-queue.face-queue').checkStatus()
 *   face retry-pending  -> strapi.service('api::face-queue.face-queue').retryPending()
 */

/* global strapi */ // strapi injected at runtime for the taskEmailDigest helper.

const STUB = (label) => async () => {
  // eslint-disable-next-line no-console
  console.log(`[cron] ${label}: stub — handler not yet ported (Phase 4/5/8)`);
};

// Daily task digest — delegates to the ported task controller's email action.
// The action reads all data itself; ctx is unused for input.
async function taskEmailDigest() {
  try {
    await strapi.controller('api::task.task').email({ state: { user: null }, query: {} });
  } catch (e) {
    strapi.log.error(`[cron] task.email failed: ${e && e.message}`);
  }
}

module.exports = {
  // Every day at 3am — daily task digest email (controller ported in P4.9).
  '0 3 * * *': {
    task: ({ strapi }) => taskEmailDigest(),
  },
  // Drain the stored-totals refresh queue every 2 minutes (P4.10 redesign:
  // DB-backed via projects.dirty — PM2-safe across all instances).
  '*/2 * * * *': {
    task: ({ strapi }) => require('./src/api/project/services/totalsRefreshScheduler').processDirty(),
  },
  // Check FACe invoice status every 30 minutes (ported in Phase 8.1).
  '*/30 * * * *': {
    task: ({ strapi }) => STUB('face.check-status'),
  },
  // Retry pending FACe submissions every 5 minutes (ported in Phase 8.1).
  '*/5 * * * *': {
    task: ({ strapi }) => STUB('face.retry-pending'),
  },
};
