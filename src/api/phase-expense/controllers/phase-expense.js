'use strict';

/**
 * phase-expense controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::phase-expense.phase-expense', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port phase-expense.findAssigned from v3 api/phase-expense/controllers/phase-expense.js
  async findAssigned(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'phase-expense.findAssigned not yet ported (Phase 4)' };
  },
}));
