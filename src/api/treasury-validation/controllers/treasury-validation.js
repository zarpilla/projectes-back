'use strict';

/**
 * treasury-validation controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::treasury-validation.treasury-validation', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port treasury-validation.toggle from v3 api/treasury-validation/controllers/treasury-validation.js
  async toggle(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'treasury-validation.toggle not yet ported (Phase 4)' };
  },
  // TODO(P4): port treasury-validation.findByKey from v3 api/treasury-validation/controllers/treasury-validation.js
  async findByKey(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'treasury-validation.findByKey not yet ported (Phase 4)' };
  },
}));
