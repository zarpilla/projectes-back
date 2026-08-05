'use strict';

/**
 * received-expense controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::received-expense.received-expense', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port received-expense.findBasic from v3 api/received-expense/controllers/received-expense.js
  async findBasic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'received-expense.findBasic not yet ported (Phase 4)' };
  },
  // TODO(P4): port received-expense.upload from v3 api/received-expense/controllers/received-expense.js
  async upload(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'received-expense.upload not yet ported (Phase 4)' };
  },
}));
