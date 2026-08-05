'use strict';

/**
 * phase-income controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::phase-income.phase-income', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port phase-income.findAssigned from v3 api/phase-income/controllers/phase-income.js
  async findAssigned(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'phase-income.findAssigned not yet ported (Phase 4)' };
  },
}));
