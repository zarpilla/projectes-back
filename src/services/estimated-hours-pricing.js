'use strict';
/* global strapi */

/**
 * issues/416: the hourly cost shown on a planning line is the person's working
 * day (jornada) that covers the line's period, not the rate of the day the
 * line was saved at.
 *
 * Until now the line kept a snapshot of its author's cost per hour at save
 * time, so a 2027 line planned in 2024 still showed the 2024 salary forever
 * (Arran de Terra's ACTGI 24-27: lines at 17.85–21.77 while everyone's real
 * cost was 19.54–22.45). The rate is re-derived from the jornadas every time
 * a line is written and every time a jornada changes:
 *
 *   - the jornada covering the line's first day; else
 *   - the first jornada overlapping the line's period; else
 *   - keep what the line already has (no jornada prices it: a future period
 *     without a jornada yet, or a jornada with no salary).
 *
 * The totals never read this amount — projectFinancials prices each day from
 * the jornadas — so this is about what the plan screen shows and stores.
 */
const ESTIMATED_HOUR = 'api::estimated-hour.estimated-hour';
const DAILY_DEDICATION = 'api::daily-dedication.daily-dedication';

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Dates arrive as 'YYYY-MM-DD' strings: comparing them as strings keeps the
// order. A jornada without costByHour doesn't price anything.
const covers = (dedication, day) =>
  !!dedication.costByHour && dedication.from <= day && day <= dedication.to;

const overlaps = (dedication, from, to) =>
  !!dedication.costByHour && dedication.to >= from && dedication.from <= to;

/**
 * The cost per hour of a line: the working day covering its first day, else
 * the first one overlapping its period. Null when no jornada prices it.
 */
const rateForLine = (dedications, from, to) => {
  if (!from || !to) return null;
  const covering = (dedications || []).find((d) => covers(d, from));
  if (covering) return Number(covering.costByHour);
  const overlapping = (dedications || []).find((d) => overlaps(d, from, to));
  return overlapping ? Number(overlapping.costByHour) : null;
};

/**
 * The amount / total_amount a stored line must have, or null to keep them: no
 * user, or no jornada of that user prices the period. total_amount follows the
 * plan modal's own rule (amount × quantity), whatever the quantity type is.
 */
const priceOfRow = (row, dedicationsByUser) => {
  const user = row.users_permissions_user && row.users_permissions_user.id;
  if (!user) return null;
  const rate = rateForLine(dedicationsByUser.get(user) || [], String(row.from), String(row.to));
  if (rate === null || !Number.isFinite(rate)) return null;
  return { amount: rate, total_amount: round2(rate * (Number(row.quantity) || 0)) };
};

// The dedications of every user in `ids`, keyed by user id.
async function dedicationsOfUsers(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const rows = await strapi.db.query(DAILY_DEDICATION).findMany({
    where: { users_permissions_user: userIds.length === 1 ? userIds[0] : { $in: userIds } },
    populate: { users_permissions_user: { select: ['id'] } },
    orderBy: [{ from: 'asc' }],
  });
  for (const row of rows) {
    const user = row.users_permissions_user && row.users_permissions_user.id;
    if (!user) continue;
    if (!map.has(user)) map.set(user, []);
    map.get(user).push(row);
  }
  return map;
}

// Rewrites the rows whose derived price differs; returns how many were written.
async function applyPrices(rows) {
  const dedicationsByUser = await dedicationsOfUsers(
    [...new Set(rows.map((r) => r.users_permissions_user && r.users_permissions_user.id).filter(Boolean))],
  );
  let written = 0;
  for (const row of rows) {
    const priced = priceOfRow(row, dedicationsByUser);
    if (!priced) continue;
    if (Number(row.amount) === priced.amount && Number(row.total_amount) === priced.total_amount) continue;
    await strapi.db.query(ESTIMATED_HOUR).update({ where: { id: row.id }, data: priced });
    written += 1;
  }
  return written;
}

/**
 * Re-prices the given estimated-hours rows (the ones a project save just
 * wrote, in the current or the original plan). Cheap: one dedication query
 * per person involved.
 */
async function rederiveRows(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return 0;
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({
    where: { id: clean.length === 1 ? clean[0] : { $in: clean } },
    populate: { users_permissions_user: { select: ['id'] } },
  });
  return applyPrices(rows);
}

/**
 * Re-prices every planning line of a person: called when her working days
 * change, because every one of her lines may move to another period's rate.
 */
async function rederiveUser(userId) {
  if (!userId) return 0;
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({
    where: { users_permissions_user: userId },
    populate: { users_permissions_user: { select: ['id'] } },
  });
  return applyPrices(rows);
}

/**
 * Startup backfill (issues/416): re-price every planning line of every person
 * with jornadas. Idempotent — a second run writes nothing.
 */
async function rederiveAll() {
  const rows = await strapi.db.query(ESTIMATED_HOUR).findMany({
    populate: { users_permissions_user: { select: ['id'] } },
  });
  const written = await applyPrices(rows);
  strapi.log.info(`[estimatedHoursPricing] ${written} of ${rows.length} planning lines re-priced`);
  return written;
}

module.exports = { rateForLine, priceOfRow, rederiveRows, rederiveUser, rederiveAll };
