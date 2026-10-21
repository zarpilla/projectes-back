'use strict';
/* global strapi */

/**
 * Startup script (issues/310): a year's official holidays for every tenant.
 *
 * Holidays for everyone (no person) are rows in `festives`. Each year's
 * official Catalan calendar is listed once in FESTIVES
 * (new-database-seed-data.js), which also seeds new databases. Registering
 * `addOfficialFestives<year>` as a run-once script in bootstrap gives every
 * existing tenant that year's dates on its next deploy.
 *
 * A date the tenant already has as a holiday for everyone (any type) is left
 * alone, so dates entered by hand are not doubled. The type is found by name;
 * a tenant that renamed it gets its first holiday type for everyone instead.
 *
 * Created through the document service, like the seed: it fills the
 * document id and the type's link row.
 */
const { FESTIVES } = require('./new-database-seed-data');

const FESTIVE = 'api::festive.festive';
const FESTIVE_TYPE = 'api::festive-type.festive-type';

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const day = (value) => String(value || '').slice(0, 10);

async function addOfficialFestives(year) {
  const official = FESTIVES.filter(([date]) => date.startsWith(`${year}-`));

  const types = await strapi.db.query(FESTIVE_TYPE).findMany({ select: ['id', 'name', 'personal'] });
  const forEveryone = types.filter((t) => t.personal === false);
  if (!forEveryone.length) {
    strapi.log.warn(`[addOfficialFestives] ${year}: no holiday type for everyone, no holidays added`);
    return [];
  }
  const typeId = (name) => (types.find((t) => sameName(t.name, name)) || forEveryone[0]).id;

  const existing = await strapi.db.query(FESTIVE).findMany({
    where: { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } },
    select: ['id', 'date'],
    populate: { users_permissions_user: { select: ['id'] } },
  });
  const taken = new Set(existing.filter((f) => !f.users_permissions_user).map((f) => day(f.date)));

  const added = [];
  for (const [date, type] of official) {
    if (taken.has(date)) continue;
    await strapi.documents(FESTIVE).create({ data: { date, festive_type: typeId(type) } });
    taken.add(date);
    added.push(date);
  }

  strapi.log.info(
    `[addOfficialFestives] ${year}: ${added.length} of ${official.length} official holidays added` +
      (added.length ? ` (${added.join(', ')})` : ''),
  );
  return added;
}

module.exports = { addOfficialFestives };
