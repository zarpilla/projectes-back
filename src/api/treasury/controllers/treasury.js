'use strict';

/**
 * treasury controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::treasury.treasury', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port treasury.forecast from v3 api/treasury/controllers/treasury.js
  async forecast(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'treasury.forecast not yet ported (Phase 4)' };
  },
}));
