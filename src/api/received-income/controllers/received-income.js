'use strict';

/**
 * received-income controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::received-income.received-income', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port received-income.findBasic from v3 api/received-income/controllers/received-income.js
  async findBasic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'received-income.findBasic not yet ported (Phase 4)' };
  },
}));
