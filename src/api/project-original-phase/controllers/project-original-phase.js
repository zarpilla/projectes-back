'use strict';

/**
 * project-original-phase controller (v5). Ported from v3 api/project-original-phases/controllers.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::project-original-phase.project-original-phase', ({ strapi }) => ({
  /**
   * GET /api/project-original-phases/project-original-phases-hours
   * Original phases with deep-populated incomes/expenses + estimated hours.
   */
  async findWithHours(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::project-original-phase.project-original-phase').findMany({
      where: opts.filters || {},
      populate: {
        incomes: {
          populate: {
            estimated_hours: { populate: { users_permissions_user: true } },
            income_type: true,
            invoice: true,
            income: true,
            bank_account: true,
          },
        },
        expenses: {
          populate: { invoice: true, expense: true, expense_type: true, bank_account: true },
        },
      },
      limit: opts.pagination?.limit ?? -1,
      orderBy: opts.sort,
    });
  },
}));
