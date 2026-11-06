'use strict';
/* global strapi */

/**
 * issues/416: the hourly cost shown on a planning line is what its hours cost
 * with the person's working days (jornades), not the rate of the day the line
 * was saved at.
 *
 * Until now the line kept a snapshot of its author's cost per hour at save
 * time, so a 2027 line planned in 2024 still showed the 2024 salary forever
 * (Arran de Terra's ACTGI 24-27: lines at 17.85–21.77 while everyone's real
 * cost was 19.54–22.45).
 *
 * The line's €/h is the weighted average of its days: the project engine
 * (calculateEstimatedTotals, the one the totals use) prices each working day
 * with the jornada covering it, festives out, and the rate is that amount ÷
 * the line's hours. A line crossing a change of jornada (or of salary) shows
 * the mix, and its total is exactly what it adds to the project's forecast.
 * A line no jornada with a salary prices (a future period without a jornada
 * yet) keeps what it has.
 *
 * It's re-derived when a line is written, when the person's jornadas change
 * (then her projects' stored totals are marked for the totals cron), and once
 * for every existing line.
 */
const ESTIMATED_HOUR = 'api::estimated-hour.estimated-hour';
const DAILY_DEDICATION = 'api::daily-dedication.daily-dedication';
const FESTIVE = 'api::festive.festive';
const PERSON = { users_permissions_user: { select: ['id'] } };

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// required on use: projectFinancials and the totals scheduler load a lot
// and the daily-dedication lifecycles require this module
const engine = () => require('../api/project/services/projectFinancials');
const projectTotals = () => require('../api/project/services/project-totals');
const scheduler = () => require('../api/project/services/totalsRefreshScheduler');

const userOf = (row) => row && row.users_permissions_user && row.users_permissions_user.id;

/**
 * The €/h of one line: what the engine says its hours cost ÷ its hours.
 * Null when nothing prices it (no dates, no person, no jornada with salary).
 */
async function rateForLine(line, dedications, festives) {
  const user = userOf(line);
  if (!line || !line.from || !line.to || !user) return null;
  const hours = {
    users_permissions_user: { id: user },
    from: String(line.from),
    to: String(line.to),
    quantity: Number(line.quantity) || 0,
    quantity_type: line.quantity_type,
  };
  const { total_estimated_hours: h, total_estimated_hours_price: price } = await engine().calculateEstimatedTotals(
    { id: 0, name: '' },
    [{ incomes: [{ estimated_hours: [hours] }] }],
    dedications || [],
    festives || [],
    false,
    { pure: true, lean: true },
  );
  if (!(h > 0) || !(price > 0)) return null;
  return round2(price / h);
}

/**
 * The amount / total_amount a stored line must have, or null to keep them.
 * total_amount follows the plan modal's rule (amount × quantity).
 */
async function priceOfRow(row, dedicationsByUser, festives) {
  const user = userOf(row);
  if (!user) return null;
  const rate = await rateForLine(row, dedicationsByUser.get(user) || [], festives);
  if (rate === null || !Number.isFinite(rate)) return null;
  return { amount: rate, total_amount: round2(rate * (Number(row.quantity) || 0)) };
}

// The dedications of every user in `ids`, keyed by user id.
async function dedicationsOfUsers(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const rows = await strapi.db.query(DAILY_DEDICATION).findMany({
    where: { users_permissions_user: userIds.length === 1 ? userIds[0] : { $in: userIds } },
    populate: PERSON,
    orderBy: [{ from: 'asc' }],
  });
  for (const row of rows) {
    const user = userOf(row);
    if (!user) continue;
    if (!map.has(user)) map.set(user, []);
    map.get(user).push(row);
  }
  return map;
}

// Everyone's and the people's own festives, as the engine reads them.
const allFestives = () => strapi.db.query(FESTIVE).findMany({ select: ['id', 'date'], populate: PERSON });

// Rewrites the rows whose derived price differs; returns how many were written.
async function applyPrices(rows) {
  if (!rows.length) return 0;
  const dedicationsByUser = await dedicationsOfUsers([...new Set(rows.map(userOf).filter(Boolean))]);
  const festives = await allFestives();
  let written = 0;
  for (const row of rows) {
    const priced = await priceOfRow(row, dedicationsByUser, festives);
    if (!priced) continue;
    if (Number(row.amount) === priced.amount && Number(row.total_amount) === priced.total_amount) continue;
    await strapi.db.query(ESTIMATED_HOUR).update({ where: { id: row.id }, data: priced });
    written += 1;
  }
  return written;
}

/**
 * Re-prices the given estimated-hours rows (the ones a project save just
 * wrote, in the current or the original plan).
 */
async function rederiveRows(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return 0;
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({
    where: { id: clean.length === 1 ? clean[0] : { $in: clean } },
    populate: PERSON,
  });
  return applyPrices(rows);
}

/**
 * Her working days changed: re-prices every planning line of the person, and
 * marks dirty every project she has planned hours in — the stored forecast
 * prices her days with the jornadas, whether a line's €/h moved or not.
 */
async function rederiveUser(userId) {
  if (!userId) return 0;
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({
    where: { users_permissions_user: userId },
    populate: { ...PERSON, phase_income: { select: ['id'] } },
  });
  const written = await applyPrices(rows);
  const incomes = [...new Set(rows.map((r) => r.phase_income && r.phase_income.id).filter(Boolean))];
  if (incomes.length) {
    const projects = await scheduler().projectIdsForPhaseRows('api::phase-income.phase-income', {
      id: { $in: incomes },
    });
    await projectTotals().markDirty(projects);
  }
  return written;
}

/**
 * Startup backfill (issues/416): re-price every planning line. Idempotent — a
 * second run writes nothing. No totals to mark: the engine never read the
 * line's amount.
 */
async function rederiveAll() {
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({ populate: PERSON });
  const written = await applyPrices(rows);
  strapi.log.info(`[estimatedHoursPricing] ${written} of ${rows.length} planning lines re-priced`);
  return written;
}

module.exports = { rateForLine, priceOfRow, rederiveRows, rederiveUser, rederiveAll };
