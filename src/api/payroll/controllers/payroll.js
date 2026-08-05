'use strict';

/**
 * payroll controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::payroll.payroll', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port payroll.createAll from v3 api/payroll/controllers/payroll.js
  async createAll(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'payroll.createAll not yet ported (Phase 4)' };
  },
}));
