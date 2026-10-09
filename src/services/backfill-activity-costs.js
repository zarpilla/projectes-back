'use strict';
/* global strapi */

/**
 * Startup script: bring "Hores executades" up to date (issues/012).
 *
 * Until the fix in the activity lifecycles, a new, edited or deleted activity
 * never marked its project dirty (the v5 lifecycle result has no relations),
 * so the stored total_real_hours(_price) stayed as the ETL left them.
 *
 * 1. Activities with no cost/hour get the one of the person's daily dedication
 *    covering the activity date, when there is one (same rule as the
 *    activity's beforeCreate). Written straight to the table: through the
 *    entity layer each row would run the lifecycles again.
 * 2. Every project with activities is marked dirty; the totals cron
 *    (config/cron.js) recomputes them in the background.
 *
 * Idempotent: a priced activity is never touched, and a dirty project is only
 * recomputed from source data.
 */
const ACTIVITY = 'api::activity.activity';
const DEDICATION = 'api::daily-dedication.daily-dedication';

const dateKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function backfillActivityCosts() {
  const dedications = await strapi.db.query(DEDICATION).findMany({
    select: ['id', 'from', 'to', 'costByHour'],
    populate: { users_permissions_user: { select: ['id'] } },
  });
  const byUser = new Map();
  for (const d of dedications) {
    const userId = d.users_permissions_user && d.users_permissions_user.id;
    if (!userId || !(Number(d.costByHour) > 0)) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(d);
  }

  const unpriced = await strapi.db.query(ACTIVITY).findMany({
    where: { $or: [{ cost_by_hour: null }, { cost_by_hour: 0 }] },
    select: ['id', 'date'],
    populate: { users_permissions_user: { select: ['id'] } },
  });

  // cost/hour -> activity ids, to write one UPDATE per distinct cost
  const idsByCost = new Map();
  for (const a of unpriced) {
    const userId = a.users_permissions_user && a.users_permissions_user.id;
    const date = dateKey(a.date);
    const dedication = (byUser.get(userId) || []).find((d) => dateKey(d.from) <= date && dateKey(d.to) >= date);
    if (!dedication) continue;
    const cost = Number(dedication.costByHour);
    if (!idsByCost.has(cost)) idsByCost.set(cost, []);
    idsByCost.get(cost).push(a.id);
  }

  const { tableName } = strapi.db.metadata.get(ACTIVITY);
  let priced = 0;
  for (const [cost, ids] of idsByCost) {
    await strapi.db.connection(tableName).whereIn('id', ids).update({ cost_by_hour: cost });
    priced += ids.length;
  }

  const { joinTable } = strapi.db.metadata.get(ACTIVITY).attributes.project;
  const projectColumn = joinTable.inverseJoinColumn.name;
  const projectIds = (await strapi.db.connection(joinTable.name).distinct(projectColumn)).map((r) => r[projectColumn]);
  if (projectIds.length) {
    await strapi.db.connection('projects').whereIn('id', projectIds).update({ dirty: true });
  }

  strapi.log.info(
    `[backfillActivityCosts] priced ${priced}/${unpriced.length} activities without cost/hour; ` +
      `${projectIds.length} projects marked dirty`,
  );
}

module.exports = { backfillActivityCosts };
