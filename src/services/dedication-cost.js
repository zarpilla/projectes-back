'use strict';
/* global strapi */

/**
 * issues/416: a jornada's cost per hour, computed by the API on every save
 * with the same rule as the working-day modal (ModalBoxWorkingDay.vue
 * calcCostByHour):
 *
 *   (monthly_salary + quota + pct_quota % of the salary) × 12
 *   ÷ working hours of the year the period starts in (Anys), 1764 h if that
 *   year has none.
 *
 * The modal priced a jornada with the year table of the day it was saved: a
 * 2026–27 jornada saved before 2026 existed in «Anys» kept the 1764 h
 * fallback (Joel at Arran de Terra: 22.40 instead of 22.45 with 1760 h). Now
 * the API re-derives it when the jornada changes and when a year's working
 * hours are created or changed; the planning lines follow the jornada
 * (estimated-hours-pricing.js).
 */
const DEDICATION = 'api::daily-dedication.daily-dedication';
const YEAR = 'api::year.year';
const DEFAULT_WORKING_HOURS = 1764;

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const blank = (v) => v === null || v === undefined || v === '';
const num = (v) => (blank(v) ? 0 : Number(v));

// 'YYYY-MM-DD' (or a Date) → the year as a number
const yearOf = (from) => {
  if (blank(from)) return null;
  const s = from instanceof Date ? from.toISOString() : String(from);
  const y = Number(s.slice(0, 4));
  return Number.isInteger(y) ? y : null;
};

/**
 * The cost per hour of a jornada, or undefined when it has no salary (then the
 * caller keeps the costByHour it has: periods without a salary price nothing).
 */
function costByHourOf(dedication, workingHours) {
  if (!dedication || blank(dedication.monthly_salary)) return undefined;
  const salary = Number(dedication.monthly_salary);
  if (!Number.isFinite(salary)) return undefined;
  const hours = Number(workingHours) > 0 ? Number(workingHours) : DEFAULT_WORKING_HOURS;
  const monthly = salary + num(dedication.quota) + (num(dedication.pct_quota) * salary) / 100;
  return round2((monthly * 12) / hours);
}

// The working hours «Anys» gives the year a period starts in (null: none).
async function workingHoursOf(year) {
  if (!year) return null;
  const row = await strapi.db.query(YEAR).findOne({ where: { year } });
  return row && !blank(row.working_hours) ? Number(row.working_hours) : null;
}

/** The cost per hour of a jornada (merged saved + sent fields), from «Anys». */
async function deriveCostByHour(dedication) {
  if (!dedication || blank(dedication.monthly_salary)) return undefined;
  return costByHourOf(dedication, await workingHoursOf(yearOf(dedication.from)));
}

/**
 * A year's working hours were created or changed: re-derive the jornadas that
 * start in it. Each one goes through the daily-dedication lifecycles, so its
 * activities and the person's planning lines follow. Returns how many changed.
 */
async function rederiveYear(year, workingHours) {
  if (!year) return 0;
  const rows = await strapi.db.query(DEDICATION).findMany({
    where: { from: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } },
  });
  let written = 0;
  for (const row of rows) {
    const cost = costByHourOf(row, workingHours);
    if (cost === undefined || (!blank(row.costByHour) && Number(row.costByHour) === cost)) continue;
    await strapi.db.query(DEDICATION).update({ where: { id: row.id }, data: { costByHour: cost } });
    written += 1;
  }
  if (written) strapi.log.info(`[dedicationCost] year ${year}: ${written} jornades re-priced`);
  return written;
}

module.exports = { costByHourOf, deriveCostByHour, rederiveYear, yearOf, DEFAULT_WORKING_HOURS };
