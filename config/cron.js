/**
 * v5 cron tasks. Ported from v3 config/functions/cron.js.
 *
 * v5 shape: each task is { schedule, task: ({ strapi }) => async (name) => {} } or a
 * bare function. All four v3 jobs are fully ported:
 *   - task.email daily 3am -> api::task.task controller email action
 *   - totals drain (2 min) -> totalsRefreshScheduler.processDirty (PM2-safe)
 *   - face check-status (30 min) -> api::face-queue.face-queue cronCheckStatus (P8.1)
 *   - face retry-pending (5 min)  -> api::face-queue.face-queue cronRetryPending (P8.1)
 */

/* global strapi */ // strapi injected at runtime for the taskEmailDigest helper.

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
  // Check FACe invoice status every 30 minutes (ported in P8.1).
  '*/30 * * * *': {
    task: ({ strapi }) => strapi.service('api::face-queue.face-queue').cronCheckStatus(),
  },
  // Retry pending FACe submissions every 5 minutes, max 10 attempts (ported in P8.1).
  '*/5 * * * *': {
    task: ({ strapi }) => strapi.service('api::face-queue.face-queue').cronRetryPending(),
  },
};
