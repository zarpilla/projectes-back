'use strict';

/**
 * received-invoice controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::received-invoice.received-invoice', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port received-invoice.findBasic from v3 api/received-invoice/controllers/received-invoice.js
  async findBasic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'received-invoice.findBasic not yet ported (Phase 4)' };
  },
  // TODO(P4): port received-invoice.upload from v3 api/received-invoice/controllers/received-invoice.js
  async upload(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'received-invoice.upload not yet ported (Phase 4)' };
  },
}));
