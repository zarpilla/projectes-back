'use strict';
/* global strapi */

/**
 * issues/371: a project billed by the hour («Hores»). Its forecast income lines
 * that carry estimated hours are priced as hours × the project's price/hour:
 * the line stores quantity = hours and amount = price, so every total and
 * report that reads lineTotal(line) keeps working unchanged. Lines without
 * estimated hours (materials, a fixed fee) keep what the user typed.
 *
 * Only the current plan (project_phases) is priced; the original plan is a
 * snapshot and stays as it was. A line already invoiced or collected (paid, or
 * linked to an invoice or an income) keeps its amount: it is what the
 * executed incomes count, and it must stay the document's amount.
 */
const { lineTotal } = require('./budget-line');

const BILLING_MODES = ['project', 'hours'];

// A missing mode (projects saved before issues/371) is «Projecte».
const effectiveBillingMode = (mode) => (mode === 'hours' ? 'hours' : 'project');

const round4 = (v) => Math.round((v + Number.EPSILON) * 10000) / 10000;

const parseDay = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

// Monday to Friday between from and to, both included (0 if a date is missing).
const weekdaysBetween = (from, to) => {
  if (!from || !to) return 0;
  const start = parseDay(from);
  const end = parseDay(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  let n = 0;
  for (let t = start; t <= end; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
};

/**
 * The hours of one estimated-hours row: a «Total» row is its quantity; a weekly
 * or monthly one is spread over the weekdays of its range the way the forecast
 * engine does (quantity / 5 per day, / 4.3 more for a month). Festive days are
 * not discounted here: the line is a budget, not a calendar.
 */
const hoursOfRow = (row) => {
  const q = Number(row && row.quantity) || 0;
  if (!row || !q) return 0;
  if (row.quantity_type === 'week') return (q / 5) * weekdaysBetween(row.from, row.to);
  if (row.quantity_type === 'month') return (q / 5 / 4.3) * weekdaysBetween(row.from, row.to);
  return q;
};

const hoursOfLine = (line) => round4(((line && line.estimated_hours) || []).reduce((s, row) => s + hoursOfRow(row), 0));

/**
 * The quantity / amount / total_amount an income line must have in a project
 * billed by the hour, or null when the line is not priced by hours (no
 * estimated hours, or the project is billed per project).
 */
const linkedId = (v) => (v && typeof v === 'object' ? v.id : v);
const isInvoiced = (line) => !!(line.paid || linkedId(line.invoice) || linkedId(line.income));

const hoursPricing = (line, mode, pricePerHour) => {
  if (effectiveBillingMode(mode) !== 'hours') return null;
  if (!line || !Array.isArray(line.estimated_hours) || !line.estimated_hours.length) return null;
  if (isInvoiced(line)) return null;
  const priced = { quantity: hoursOfLine(line), amount: round4(Number(pricePerHour) || 0) };
  priced.total_amount = lineTotal(priced);
  return priced;
};

const changed = (line, priced) =>
  Number(line.quantity) !== priced.quantity || Number(line.amount) !== priced.amount || Number(line.total_amount) !== priced.total_amount;

/**
 * Prices the stored current-plan income lines of a project billed by the hour.
 * Called after the phases are saved and whenever the mode or the price/hour
 * change. Writes only the lines whose figures differ; returns how many.
 */
const priceHoursLines = async (projectId, { mode, pricePerHour } = {}) => {
  if (effectiveBillingMode(mode) !== 'hours') return 0;
  const incomes = await strapi.db.query('api::phase-income.phase-income').findMany({
    where: { project_phase: { project: { id: projectId } } },
    select: ['id', 'quantity', 'amount', 'total_amount', 'paid'],
    populate: {
      estimated_hours: { select: ['id', 'quantity', 'quantity_type', 'from', 'to'] },
      invoice: { select: ['id'] },
      income: { select: ['id'] },
    },
  });
  let written = 0;
  for (const line of incomes) {
    const priced = hoursPricing(line, mode, pricePerHour);
    if (!priced || !changed(line, priced)) continue;
    await strapi.db.query('api::phase-income.phase-income').update({ where: { id: line.id }, data: priced });
    written += 1;
  }
  return written;
};

module.exports = {
  BILLING_MODES,
  isInvoiced,
  effectiveBillingMode,
  weekdaysBetween,
  hoursOfRow,
  hoursOfLine,
  hoursPricing,
  priceHoursLines,
};
