'use strict';

/**
 * face-queue controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::face-queue.face-queue', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port face-queue.verifySetup from v3 api/face-queue/controllers/face-queue.js
  async verifySetup(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'face-queue.verifySetup not yet ported (Phase 4)' };
  },
  // TODO(P4): port face-queue.checkStatus from v3 api/face-queue/controllers/face-queue.js
  async checkStatus(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'face-queue.checkStatus not yet ported (Phase 4)' };
  },
}));
