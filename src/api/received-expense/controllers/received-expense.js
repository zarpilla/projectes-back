'use strict';
/* global strapi */

/**
 * received-expense controller (v5). Ported from v3 api/received-expense/controllers/received-expense.js.
 * Custom endpoints: findBasic, upload (delegates to the shared invoice-parser proxy —
 * same Z.ai pipeline as received-invoice).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');
const { proxyUpload } = require('../../../services/invoice-parser-proxy');

module.exports = createCoreController('api::received-expense.received-expense', ({ strapi }) => ({
  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::received-expense.received-expense').findMany({
      where: opts.filters || {},
      populate: { contact: true, projects: true, document_type: true },
      limit: opts.pagination?.limit,
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
