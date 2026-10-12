'use strict';
/* global strapi */

/**
 * Startup script (issues/033): expense types without VAT, and the budgets
 * that use them.
 *
 * Until the fix, the project totals read a 0 % expense type as "no VAT set"
 * and budgeted its lines at 21 %.
 *
 * 1. The seeded types that carry no VAT but were created with an empty
 *    `vat_pct` (which does mean 21 %) are set to 0. Only those names, and only
 *    while still empty: a VAT someone typed in is never overwritten.
 * 2. Every project with an expense line of a 0 % type is marked dirty; the
 *    totals cron (config/cron.js) recomputes them in the background.
 *
 * Idempotent: a type with a VAT is never touched, and a dirty project is only
 * recomputed from source data.
 */
const { projectIdsForPhaseRows } = require('../api/project/services/totalsRefreshScheduler');

const EXPENSE_TYPE = 'api::expense-type.expense-type';
const PHASE_EXPENSE = 'api::phase-expense.phase-expense';
const ZERO_VAT_NAMES = ['Quotes', 'Comissions bancàries', "Ajustament salarial final d'any"];

async function zeroVatExpenseTypes() {
  const { tableName } = strapi.db.metadata.get(EXPENSE_TYPE);
  const unset = await strapi.db.query(EXPENSE_TYPE).findMany({
    where: { name: { $in: ZERO_VAT_NAMES }, vat_pct: null },
    select: ['id', 'name'],
  });
  if (unset.length) {
    await strapi.db
      .connection(tableName)
      .whereIn(
        'id',
        unset.map((t) => t.id),
      )
      .update({ vat_pct: 0 });
  }

  const projectIds = await projectIdsForPhaseRows(PHASE_EXPENSE, { expense_type: { vat_pct: 0 } });
  if (projectIds.length) {
    await strapi.db.connection('projects').whereIn('id', projectIds).update({ dirty: true });
  }

  strapi.log.info(
    `[zeroVatExpenseTypes] ${unset.length} expense types set to 0 % VAT` +
      `${unset.length ? ` (${unset.map((t) => t.name).join(', ')})` : ''}; ` +
      `${projectIds.length} projects marked dirty`,
  );
}

module.exports = { zeroVatExpenseTypes, ZERO_VAT_NAMES };
