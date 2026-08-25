'use strict';

/**
 * phase-income controller (v5). Ported from v3 api/phase-income/controllers/phase-income.js.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::phase-income.phase-income', ({ strapi }) => ({
  /**
   * GET /api/phase-incomes/assigned
   * Returns ids of incomes/invoices already assigned to project phases.
   */
  async findAssigned(ctx) {
    const opts = adaptQuery(ctx.query);
    const phases = await strapi.db.query('api::phase-income.phase-income').findMany({
      where: opts.filters || {},
      populate: { income: true, invoice: true },
      limit: opts.pagination?.limit ?? -1,
      orderBy: opts.sort,
    });

    return {
      incomes: phases.filter((p) => p.income?.id).map((p) => p.income.id),
      invoices: phases.filter((p) => p.invoice?.id).map((p) => p.invoice.id),
    };
  },
}));
