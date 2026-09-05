'use strict';

/**
 * project-phase controller (v5). Core CRUD is provided by createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

/**
 * The graph v3's `project-phases.find` populated (api/project-phases/controllers).
 * ProjectForm loads the execution phases from here — "Load execution phases with
 * estimated hours" — and builds the PLANIFICACIÓ PREVISTA chart from
 * `incomes.estimated_hours`. The default one-level populate stops at `incomes`,
 * so the chart came up empty and a save echoed `estimated_hours: []` back.
 * Mirrors project-original-phase.findWithHours, which serves the ORIGINAL view.
 */
const PHASE_GRAPH = {
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
};

module.exports = createCoreController('api::project-phase.project-phase', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    // '*' is the v3-compat middleware's default; only an explicit caller populate wins.
    if (!ctx.query.populate || ctx.query.populate === '*') {
      ctx.query = { ...ctx.query, populate: PHASE_GRAPH };
    }
    return super.find(ctx);
  },

  // Default core actions (findOne/create/update/delete) are inherited.
}));
