'use strict';
/* global strapi */

/**
 * Startup script (issues/093): merge the towns that exist twice under the
 * same name, ignoring case and spaces (Diligència: «Barcelona» and
 * «Barcelona », «Manlleu» and «Manlleu », «Cabrils» twice), and trim the
 * names. The town with the lowest id is kept; the routes and pickups of the
 * others move to it, a route linked twice to the same town keeps one link,
 * and the others are deleted. The city lifecycles stop new duplicates.
 *
 * Written straight to the tables: the link rows are the only references to a
 * town (delivery points and orders keep the town as text), and the lifecycles
 * would refuse the intermediate names.
 */
const normalize = (name) => String(name || '').trim().replace(/\s+/g, ' ');

/**
 * cities: [{ id, name }]; links: [{ city_route_id, city_id, route_id }].
 * Returns { renames: [{ id, from, name }], merges: [{ keep, name, others, redundant }] }.
 */
function planCityMerge(cities, links) {
  const groups = new Map();
  for (const city of [...cities].sort((a, b) => a.id - b.id)) {
    const key = normalize(city.name).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(city);
  }

  const renames = [];
  const merges = [];
  for (const [keep, ...others] of groups.values()) {
    const name = normalize(keep.name);
    const ids = [keep.id, ...others.map((c) => c.id)];
    const own = links
      .filter((l) => ids.includes(l.city_id))
      // the kept town's links first, then the others'
      .sort((a, b) => ids.indexOf(a.city_id) - ids.indexOf(b.city_id) || a.city_route_id - b.city_route_id);
    const seen = new Set();
    const redundant = [];
    for (const link of own) {
      if (seen.has(link.route_id)) redundant.push(link.city_route_id);
      seen.add(link.route_id);
    }
    if (others.length || redundant.length) {
      merges.push({ keep: keep.id, from: keep.name, name, others: others.map((c) => c.id), redundant });
    } else if (name !== keep.name) {
      renames.push({ id: keep.id, from: keep.name, name });
    }
  }
  return { renames, merges };
}

async function mergeDuplicateCities() {
  const knex = strapi.db.connection;
  const cities = await knex('cities').select('id', 'name');
  const links = await knex('city_routes_city_lnk as c')
    .join('city_routes_route_lnk as r', 'r.city_route_id', 'c.city_route_id')
    .select('c.city_route_id', 'c.city_id', 'r.route_id');
  const { renames, merges } = planCityMerge(cities, links);

  for (const { id, from, name } of renames) {
    await knex('cities').where({ id }).update({ name });
    strapi.log.info(`[mergeDuplicateCities] #${id} «${from}» renamed to «${name}»`);
  }
  for (const { keep, name, others, redundant } of merges) {
    await knex.transaction(async (trx) => {
      if (redundant.length) {
        await trx('city_routes_route_lnk').whereIn('city_route_id', redundant).del();
        await trx('city_routes_city_lnk').whereIn('city_route_id', redundant).del();
        await trx('city_routes').whereIn('id', redundant).del();
      }
      if (others.length) {
        await trx('city_routes_city_lnk').whereIn('city_id', others).update({ city_id: keep });
        await trx('pickups_city_lnk').whereIn('city_id', others).update({ city_id: keep });
        await trx('cities').whereIn('id', others).del();
      }
      await trx('cities').where({ id: keep }).update({ name });
    });
    strapi.log.info(
      `[mergeDuplicateCities] «${name}»: kept #${keep}` +
        (others.length ? `, merged ${others.map((id) => `#${id}`).join(', ')}` : '') +
        (redundant.length ? `, ${redundant.length} repeated route links removed` : ''),
    );
  }
}

module.exports = { mergeDuplicateCities, planCityMerge };
