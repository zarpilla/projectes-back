'use strict';

/**
 * phase-expense controller (v5). Ported from v3 api/phase-expense/controllers/phase-expense.js.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::phase-expense.phase-expense', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/phase-expenses/assigned
   * Returns ids of expenses/invoices already assigned to project phases.
   */
  async findAssigned(ctx) {
    const opts = adaptQuery(ctx.query);
    const phases = await strapi.db.query('api::phase-expense.phase-expense').findMany({
      where: opts.filters || {},
      populate: { expense: true, invoice: true },
      limit: dbLimit(opts),
      orderBy: opts.sort,
    });

    return {
      expenses: phases.filter((p) => p.expense?.id).map((p) => p.expense.id),
      invoices: phases.filter((p) => p.invoice?.id).map((p) => p.invoice.id),
    };
  },
}));
