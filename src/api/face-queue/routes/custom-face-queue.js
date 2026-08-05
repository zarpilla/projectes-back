'use strict';

/**
 * face-queue CUSTOM routes (v5). Ported from v3 api/face-queue/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/face-queues automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/verify-setup',
      handler: 'face-queue.verifySetup',
    },
    {
      method: 'GET',
      path: '/:id/check-status',
      handler: 'face-queue.checkStatus',
    },
  ],
};
