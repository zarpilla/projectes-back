'use strict';

/**
 * order controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port orders.table from v3 api/orders/controllers/orders.js
  async table(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.table not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.infoAll from v3 api/orders/controllers/orders.js
  async infoAll(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.infoAll not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.checkMultidelivery from v3 api/orders/controllers/orders.js
  async checkMultidelivery(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.checkMultidelivery not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.collectionPointRoutes from v3 api/orders/controllers/orders.js
  async collectionPointRoutes(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.collectionPointRoutes not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.createCSV from v3 api/orders/controllers/orders.js
  async createCSV(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.createCSV not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.invoice from v3 api/orders/controllers/orders.js
  async invoice(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.invoice not yet ported (Phase 4)' };
  },
  // TODO(P4): port orders.pdfmultiple from v3 api/orders/controllers/orders.js
  async pdfmultiple(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'order.pdfmultiple not yet ported (Phase 4)' };
  },
}));
