'use strict';
/* global strapi */

/**
 * received-invoice controller (v5). Ported from v3 api/received-invoice/controllers/received-invoice.js.
 * Custom endpoints: findBasic, upload (proxy to the Z.ai invoice-parser service).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const { proxyUpload } = require('../../../services/invoice-parser-proxy');

module.exports = createCoreController('api::received-invoice.received-invoice', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::received-invoice.received-invoice').findMany({
      where: opts.filters || {},
      populate: { contact: true, projects: true, document_type: true },
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
  },

  /**
   * POST /api/received-invoices/upload
   * Forwards the uploaded PDF to the standalone Z.ai invoice-parser service
   * and returns the structured JSON. URL/token configured on the `me` record.
   */
  async upload(ctx) {
    return proxyUpload(strapi, ctx);
  },
}));
