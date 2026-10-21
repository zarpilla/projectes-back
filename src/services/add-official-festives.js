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
 * Hores anuals compares each type's days with its maximum (Festiu Estatal 8,
 * Festiu Catalunya 4) and takes the missing ones as still to come. When the
 * year has another count (2027: 9 and 3), the year gets its own maximum, a
 * «Festius d'usuari» row with the year and no person, as was done by hand for
 * 2024. A maximum already set for that year is kept. A missing year is
 * created with the hours and deductible VAT of the latest earlier one.
 *
 * Created through the document service, like the seed: it fills the
 * document id and the link rows.
 */
const { FESTIVES, YEAR_DEFAULTS } = require('./new-database-seed-data');

const FESTIVE = 'api::festive.festive';
const FESTIVE_TYPE = 'api::festive-type.festive-type';
const USER_FESTIVE = 'api::user-festive.user-festive';
const YEAR = 'api::year.year';

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const day = (value) => String(value || '').slice(0, 10);
const idOf = (value) => (value && typeof value === 'object' ? value.id : value);

// The holidays for everyone of the year: one per date, as Hores anuals counts them
async function holidaysForEveryone(year) {
  const rows = await strapi.db.query(FESTIVE).findMany({
    where: { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } },
    select: ['id', 'date'],
    populate: { users_permissions_user: { select: ['id'] }, festive_type: { select: ['id'] } },
  });
  const byDate = new Map();
  for (const f of rows) {
    if (!f.users_permissions_user && !byDate.has(day(f.date))) byDate.set(day(f.date), idOf(f.festive_type));
  }
  return byDate;
}

async function yearRow(year) {
  const years = await strapi.db.query(YEAR).findMany({ select: ['id', 'year', 'working_hours', 'deductible_vat_pct'] });
  const found = years.filter((y) => Number(y.year) === year).sort((a, b) => a.id - b.id)[0];
  if (found) return found;
  const previous = years.filter((y) => Number(y.year) < year).sort((a, b) => b.year - a.year)[0];
  const data = {
    year,
    working_hours: previous && previous.working_hours != null ? previous.working_hours : YEAR_DEFAULTS.working_hours,
    deductible_vat_pct:
      previous && previous.deductible_vat_pct != null ? previous.deductible_vat_pct : YEAR_DEFAULTS.deductible_vat_pct,
  };
  const created = await strapi.documents(YEAR).create({ data });
  strapi.log.info(
    `[addOfficialFestives] year ${year} created (${data.working_hours} h, ${data.deductible_vat_pct} % VAT, from ${previous ? previous.year : 'the defaults'})`,
  );
  return { id: created.id, ...data };
}

// The year's own maximum for each official type whose count differs from the type's
async function setYearMaximums(year, officialTypes) {
  const byDate = await holidaysForEveryone(year);
  const counts = new Map();
  for (const typeId of byDate.values()) counts.set(typeId, (counts.get(typeId) || 0) + 1);

  const changes = officialTypes
    .map((type) => ({ type, max: counts.get(type.id) || 0 }))
    .filter(({ type, max }) => max !== Number(type.max));
  if (!changes.length) return [];

  const existing = await strapi.db.query(USER_FESTIVE).findMany({
    select: ['id', 'max'],
    populate: {
      year: { select: ['id', 'year'] },
      festive_type: { select: ['id'] },
      users_permissions_user: { select: ['id'] },
    },
  });
  const hasOwnMax = (typeId) =>
    existing.some(
      (uf) => !uf.users_permissions_user && uf.year && Number(uf.year.year) === year && idOf(uf.festive_type) === typeId,
    );

  const set = [];
  let yearId;
  for (const { type, max } of changes) {
    if (hasOwnMax(type.id)) {
      strapi.log.info(`[addOfficialFestives] ${year}: ${type.name} keeps the maximum already set for the year`);
      continue;
    }
    if (!yearId) yearId = (await yearRow(year)).id;
    await strapi.documents(USER_FESTIVE).create({ data: { festive_type: type.id, year: yearId, max } });
    set.push({ type: type.name, max });
  }
  if (set.length) {
    strapi.log.info(
      `[addOfficialFestives] ${year}: maximum of the year ${set.map((s) => `${s.type} ${s.max}`).join(', ')}`,
    );
  }
  return set;
}

async function addOfficialFestives(year) {
  const official = FESTIVES.filter(([date]) => date.startsWith(`${year}-`));

  const types = await strapi.db.query(FESTIVE_TYPE).findMany({ select: ['id', 'name', 'personal', 'max'] });
  const forEveryone = types.filter((t) => t.personal === false);
  if (!forEveryone.length) {
    strapi.log.warn(`[addOfficialFestives] ${year}: no holiday type for everyone, no holidays added`);
    return { added: [], maximums: [] };
  }
  const typeOf = (name) => types.find((t) => sameName(t.name, name)) || forEveryone[0];

  const taken = new Set((await holidaysForEveryone(year)).keys());

  const added = [];
  for (const [date, name] of official) {
    if (taken.has(date)) continue;
    await strapi.documents(FESTIVE).create({ data: { date, festive_type: typeOf(name).id } });
    taken.add(date);
    added.push(date);
  }

  strapi.log.info(
    `[addOfficialFestives] ${year}: ${added.length} of ${official.length} official holidays added` +
      (added.length ? ` (${added.join(', ')})` : ''),
  );

  const officialTypes = [...new Map(official.map(([, name]) => [typeOf(name).id, typeOf(name)])).values()];
  const maximums = await setYearMaximums(year, officialTypes);
  return { added, maximums };
}

module.exports = { addOfficialFestives };
