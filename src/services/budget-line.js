'use strict';

/**
 * Budget lines (phase incomes / expenses, current and original plan): quantity
 * and unit price keep 4 decimals, the line total is rounded to cents. The one
 * formula every total uses — project totals, Resum, treasury, reports
 * (issues/194: a typed 0,0357 was stored as 0,04 and each place added it up
 * its own way).
 */
const BUDGET_LINE_SCALE = 4;

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const lineTotal = (line) => round2((Number(line && line.quantity) || 0) * (Number(line && line.amount) || 0));

module.exports = { BUDGET_LINE_SCALE, lineTotal };
