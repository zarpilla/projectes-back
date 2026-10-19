'use strict';
/* global strapi */

/**
 * Startup script: budget lines whose stored total disagrees with quantity ×
 * unit price (issues/194). Runs after widenBudgetLineDecimals.
 *
 * Quantity and price were stored with 2 decimals while the total kept what was
 * typed: 0,0357 × 98.750 stored as quantity 0,04 with total 3.525,38. When the
 * total gives back a 4-decimal value that rounds to the stored one (and differs
 * from it by at least 0,001, so 1 doesn't become 0,9997), that value is
 * restored: quantity 0,0357, or price 1.234,565. Every other mismatch keeps
 * quantity and price and gets the total recomputed (the user's call,
 * 2026-10-19: quantity × price wins). Each change is logged; the projects of
 * the changed lines are marked dirty for the totals cron.
 *
 * Idempotent: a repaired line agrees with its total and is not picked again.
 */
const { lineTotal } = require('./budget-line');

const UIDS = ['api::phase-income.phase-income', 'api::phase-expense.phase-expense'];

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const round4 = (v) => Math.round((v + Number.EPSILON) * 10000) / 10000;

// the 4-decimal value of `field` that gives `total` with the other factor
const restored = (row, field, other, total) => {
  const stored = Number(row[field]) || 0;
  const by = Number(row[other]) || 0;
  if (!by) return null;
  const value = round4(total / by);
  if (round2(value) !== stored || Math.abs(value - stored) < 0.001) return null;
  return lineTotal({ ...row, [field]: value }) === total ? value : null;
};

/** The changes for lines whose total ≠ quantity × price: [{ id, data, from }]. */
function budgetLineRepairs(rows) {
  const repairs = [];
  for (const row of rows) {
    if (row.total_amount === null || row.total_amount === undefined) continue;
    const total = round2(Number(row.total_amount));
    if (lineTotal(row) === total) continue;
    const from = { quantity: row.quantity, amount: row.amount, total_amount: row.total_amount };
    const quantity = restored(row, 'quantity', 'amount', total);
    if (quantity !== null) {
      repairs.push({ id: row.id, data: { quantity }, from });
      continue;
    }
    const amount = restored(row, 'amount', 'quantity', total);
    if (amount !== null) {
      repairs.push({ id: row.id, data: { amount }, from });
      continue;
    }
    repairs.push({ id: row.id, data: { total_amount: lineTotal(row) }, from });
  }
  return repairs;
}

const projectIds = (lines) => {
  const ids = new Set();
  for (const l of lines) {
    for (const phase of [l.project_phase, l.project_original_phase]) {
      if (phase && phase.project && phase.project.id) ids.add(phase.project.id);
    }
  }
  return [...ids];
};

async function repairBudgetLineTotals() {
  const dirty = new Set();
  for (const uid of UIDS) {
    const { tableName } = strapi.db.metadata.get(uid);
    const rows = await strapi.db.connection(tableName).select('id', 'quantity', 'amount', 'total_amount');
    const repairs = budgetLineRepairs(rows);
    for (const r of repairs) {
      await strapi.db.connection(tableName).where({ id: r.id }).update(r.data);
      strapi.log.info(`[repairBudgetLineTotals] ${tableName} ${r.id}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.data)}`);
    }
    if (!repairs.length) continue;
    const lines = await strapi.db.query(uid).findMany({
      where: { id: { $in: repairs.map((r) => r.id) } },
      select: ['id'],
      populate: {
        project_phase: { select: ['id'], populate: { project: { select: ['id'] } } },
        project_original_phase: { select: ['id'], populate: { project: { select: ['id'] } } },
      },
    });
    projectIds(lines).forEach((id) => dirty.add(id));
  }
  if (dirty.size) {
    await strapi.db.connection('projects').whereIn('id', [...dirty]).update({ dirty: true });
  }
  strapi.log.info(`[repairBudgetLineTotals] ${dirty.size} projects marked dirty`);
}

module.exports = { repairBudgetLineTotals, budgetLineRepairs };
