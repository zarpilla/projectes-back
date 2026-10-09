'use strict';
/* global strapi */

/**
 * received-expense controller (v5). Ported from v3 api/received-expense/controllers/received-expense.js.
 * Custom endpoints: findBasic, upload (delegates to the shared invoice-parser proxy —
 * same Z.ai pipeline as received-invoice).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const { proxyUpload } = require('../../../services/invoice-parser-proxy');

module.exports = createCoreController('api::received-expense.received-expense', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::received-expense.received-expense').findMany({
      where: opts.filters || {},
      // issues/013: v3 auto-populated components; v5 does not. The lists read
      // lines[0].concept (Concepte column, Excel export) and contact_info.
      populate: { contact: true, projects: true, document_type: true, lines: true, contact_info: true },
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
  },

  /**
   * POST /api/received-expenses/upload
   * Parses the uploaded PDF via the Z.ai invoice-parser (shared with received-invoice).
   */
  async upload(ctx) {
    return proxyUpload(strapi, ctx);
  },
}));
