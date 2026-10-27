'use strict';

/**
 * received-income controller (v5). Ported from v3 api/received-income/controllers.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit, wantsNoRows } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const incomeListPopulate = require('../../../services/income-list-populate');

module.exports = createCoreController('api::received-income.received-income', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/received-incomes/basic
   */
  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    // issues/260: `_limit=0` = no rows, as in v3 (db.query ignores limit 0)
    if (wantsNoRows(opts)) return [];
    return strapi.db.query('api::received-income.received-income').findMany({
      where: opts.filters || {},
      // only what Ingressos shows and exports (issues/013, issues/330)
      populate: incomeListPopulate.RECEIVED_INCOME,
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
  },
}));
