'use strict';

/**
 * task controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::task.task', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port task.email from v3 api/task/controllers/task.js
  async email(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'task.email not yet ported (Phase 4)' };
  },
}));
