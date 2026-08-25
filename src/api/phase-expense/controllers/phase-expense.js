'use strict';

/**
 * phase-expense controller (v5). Ported from v3 api/phase-expense/controllers/phase-expense.js.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::phase-expense.phase-expense', ({ strapi }) => ({
  /**
   * GET /api/phase-expenses/assigned
   * Returns ids of expenses/invoices already assigned to project phases.
   */
  async findAssigned(ctx) {
    const opts = adaptQuery(ctx.query);
    const phases = await strapi.db.query('api::phase-expense.phase-expense').findMany({
      where: opts.filters || {},
      populate: { expense: true, invoice: true },
      limit: opts.pagination?.limit ?? -1,
      orderBy: opts.sort,
    });

    return {
      expenses: phases.filter((p) => p.expense?.id).map((p) => p.expense.id),
      invoices: phases.filter((p) => p.invoice?.id).map((p) => p.invoice.id),
    };
  },
}));
