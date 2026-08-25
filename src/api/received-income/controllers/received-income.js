'use strict';

/**
 * received-income controller (v5). Ported from v3 api/received-income/controllers.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::received-income.received-income', ({ strapi }) => ({
  /**
   * GET /api/received-incomes/basic
   */
  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::received-income.received-income').findMany({
      where: opts.filters || {},
      populate: { contact: true, projects: true, document_type: true },
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
  },
}));
