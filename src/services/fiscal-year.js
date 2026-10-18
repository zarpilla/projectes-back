'use strict';

/**
 * Fiscal year of the entity (Configuració general › Projectes,
 * `me.options.fiscal_year_start_month`). Most entities close on 31 December
 * (start month 1, every function here is then the calendar year); a training
 * centre may run September–August (start month 9).
 *
 * A fiscal year is named by the year it starts in: with start month 9, 2026
 * is September 2026 – August 2027 (the front shows it as «2026/27»).
 *
 * Only the project economics are grouped by fiscal year. VAT quarters, the
 * deductible VAT % of Taules auxiliars › Anys, invoice series, payrolls and
 * working hours stay on the calendar year: they follow tax and labour rules.
 */

const MONTHS = 12;

/** The configured start month (1–12); 1 when unset or invalid. */
function fiscalYearStartMonth(me) {
  const value = Number(me && me.options && me.options.fiscal_year_start_month);
  return Number.isInteger(value) && value >= 1 && value <= MONTHS ? value : 1;
}

/**
 * Fiscal year (as a 4-digit string) of a 'YYYY-MM-DD…' date, or null when the
 * date has no year and month.
 */
function fiscalYearOf(date, startMonth = 1) {
  const match = /^(\d{4})-(\d{2})/.exec(String(date || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return String(startMonth > 1 && month < startMonth ? year - 1 : year).padStart(4, '0');
}

/** Last day ('YYYY-MM-DD') of a fiscal year: 2026 with start month 9 → 2027-08-31. */
function fiscalYearEnd(year, startMonth = 1) {
  if (startMonth <= 1) return `${year}-12-31`;
  const endYear = Number(year) + 1;
  const endMonth = startMonth - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

module.exports = { fiscalYearStartMonth, fiscalYearOf, fiscalYearEnd };
