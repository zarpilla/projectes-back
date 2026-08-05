'use strict';

/**
 * emitted-invoice controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::emitted-invoice.emitted-invoice', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port emitted-invoice.findBasic from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async findBasic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.findBasic not yet ported (Phase 4)' };
  },
  // TODO(P4): port emitted-invoice.payVat from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async payVat(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.payVat not yet ported (Phase 4)' };
  },
  // TODO(P4): port emitted-invoice.payVatIds from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async payVatIds(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.payVatIds not yet ported (Phase 4)' };
  },
  // TODO(P4): port emitted-invoice.sendInvoiceByEmail from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async sendInvoiceByEmail(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.sendInvoiceByEmail not yet ported (Phase 4)' };
  },
  // TODO(P4): port emitted-invoice.pendingProvider from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async pendingProvider(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.pendingProvider not yet ported (Phase 4)' };
  },
  // TODO(P4): port emitted-invoice.pdf from v3 api/emitted-invoice/controllers/emitted-invoice.js
  async pdf(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'emitted-invoice.pdf not yet ported (Phase 4)' };
  },
}));
