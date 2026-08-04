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

const STUB = (label) => async () => {
  // eslint-disable-next-line no-console
  console.log(`[cron] ${label}: stub — handler not yet ported (Phase 4/5/8)`);
};

module.exports = {
  // Every day at 3am — daily task digest email (ported in Phase 4.9).
  '0 3 * * *': {
    task: ({ strapi }) => STUB('task.email'),
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
