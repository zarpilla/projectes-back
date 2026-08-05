'use strict';

/**
 * project-original-phas controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::project-original-phas.project-original-phas', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port project-original-phases.findWithHours from v3 api/project-original-phases/controllers/project-original-phases.js
  async findWithHours(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project-original-phas.findWithHours not yet ported (Phase 4)' };
  },
}));
