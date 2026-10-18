'use strict';
/* global strapi */

/**
 * Startup script (issues/143): the project totals now take an expense line's
 * own VAT (its "IVA" in the form) before its type's.
 *
 * 1. A line at 21 % whose type is at 0 % is set to 0. 21 is the form's
 *    default for a new line, and the line only follows its type when the type
 *    is changed; the seeded VAT-free types were empty (so 21 %) until
 *    issues/033 set them to 0, which left their lines at 21. Without this
 *    step those lines would get their 21 % VAT back.
 * 2. Every project with a line whose own VAT differs from the one the totals
 *    used (its type's, or 21) is marked dirty; the totals cron
 *    (config/cron.js) recomputes them in the background.
 *
 * Idempotent: after step 1 no line is at 21 % on a 0 % type, and a dirty
 * project is only recomputed from source data.
 */
const { projectIdsForPhaseRows } = require('../api/project/services/totalsRefreshScheduler');

const PHASE_EXPENSE = 'api::phase-expense.phase-expense';

const isSet = (v) => v !== null && v !== undefined && v !== '';
// the rule before issues/143: the type's VAT, or 21
const typeVatPct = (line) =>
  line.expense_type && isSet(line.expense_type.vat_pct) ? Number(line.expense_type.vat_pct) : 21;

async function lineVatOverType() {
  const { tableName } = strapi.db.metadata.get(PHASE_EXPENSE);
  const stale = await strapi.db.query(PHASE_EXPENSE).findMany({
    where: { vat_pct: 21, expense_type: { vat_pct: 0 } },
    select: ['id'],
  });
  if (stale.length) {
    await strapi.db
      .connection(tableName)
      .whereIn(
        'id',
        stale.map((l) => l.id),
      )
      .update({ vat_pct: 0 });
  }

  const lines = await strapi.db.query(PHASE_EXPENSE).findMany({
    where: { vat_pct: { $notNull: true } },
    select: ['id', 'vat_pct'],
    populate: { expense_type: { select: ['vat_pct'] } },
  });
  const changed = lines
    .filter((l) => Number(l.vat_pct) !== typeVatPct(l))
    .map((l) => l.id);

  const projectIds = changed.length
    ? await projectIdsForPhaseRows(PHASE_EXPENSE, { id: { $in: changed } })
    : [];
  if (projectIds.length) {
    await strapi.db.connection('projects').whereIn('id', projectIds).update({ dirty: true });
  }

  strapi.log.info(
    `[lineVatOverType] ${stale.length} lines at 21 % on a 0 % type set to 0; ` +
      `${changed.length} lines with their own VAT, ${projectIds.length} projects marked dirty`,
  );
}

module.exports = { lineVatOverType };
