'use strict';

/**
 * `GET /api/contacts/orders`: the delivery points (contacts with an owner),
 * with how many orders went to each in the last year, the members who placed
 * them and the routes of its town. «Punts d'entrega» (ContactsTable) waits
 * for it before showing the office columns.
 *
 * It loaded every order of the year, whole, with its contact and owner
 * populated, then looked each contact up with a linear search per order: on
 * diligencia ~13,500 orders × ~800 points, several seconds. Two grouped
 * queries over the order links answer the counts and the members; the points
 * and the city routes are read once, with the few fields used.
 */

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';
const USER = 'plugin::users-permissions.user';
const CITY_ROUTE = 'api::city-route.city-route';

/** `YYYY-MM-DD` one year before `now` (estimated_delivery_date is a date column). */
function oneYearAgo(now = new Date()) {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * `{ counts: Map<contactId, n>, owners: Map<contactId, [{ id, name }]> }` for
 * the orders with an estimated delivery date on or after `since`. Members come
 * in the order of their first order to the point, as the old loop gave them.
 */
async function orderStatsPerContact(strapi, since) {
  const { tableName, attributes } = strapi.db.metadata.get(ORDER);
  const ownerLnk = attributes.owner.joinTable;
  const contactLnk = attributes.contact.joinTable;
  const users = strapi.db.metadata.get(USER).tableName;
  const contactCol = `oc.${contactLnk.inverseJoinColumn.name}`;
  const ownerCol = `ow.${ownerLnk.inverseJoinColumn.name}`;
  const knex = strapi.db.connection;

  const base = () =>
    knex(`${tableName} as o`)
      .join(`${contactLnk.name} as oc`, `oc.${contactLnk.joinColumn.name}`, 'o.id')
      .where('o.estimated_delivery_date', '>=', since);

  const [countRows, ownerRows] = await Promise.all([
    base()
      .groupBy(contactCol)
      .select({ contact: contactCol })
      .select(knex.raw('COUNT(DISTINCT o.id) as num_orders')),
    base()
      .join(`${ownerLnk.name} as ow`, `ow.${ownerLnk.joinColumn.name}`, 'o.id')
      .join(`${users} as u`, 'u.id', ownerCol)
      .groupBy(contactCol, ownerCol, 'u.username')
      .select({ contact: contactCol, owner: ownerCol, username: 'u.username' })
      .select(knex.raw('MIN(o.id) as first_order'))
      .orderBy('first_order'),
  ]);

  const counts = new Map(countRows.map((r) => [Number(r.contact), Number(r.num_orders)]));
  const owners = new Map();
  for (const r of ownerRows) {
    const id = Number(r.contact);
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push({ id: Number(r.owner), name: r.username || 'Unknown' });
  }
  return { counts, owners };
}

/** City name → route names, from the city routes. */
async function routesPerCity(strapi) {
  const cityRoutes = await strapi.db.query(CITY_ROUTE).findMany({
    select: ['id'],
    populate: { city: { select: ['name'] }, route: { select: ['name'] } },
  });
  const byCity = new Map();
  for (const cr of cityRoutes) {
    if (!cr.city || !cr.route?.name) continue;
    if (!byCity.has(cr.city.name)) byCity.set(cr.city.name, []);
    byCity.get(cr.city.name).push(cr.route.name);
  }
  return byCity;
}

async function contactsOrdersSummary(strapi, now = new Date()) {
  const [points, { counts, owners }, routesByCity] = await Promise.all([
    strapi.db.query(CONTACT).findMany({
      select: ['id', 'trade_name', 'city'],
      where: { owner: { $notNull: true } },
    }),
    orderStatsPerContact(strapi, oneYearAgo(now)),
    routesPerCity(strapi),
  ]);

  return points.map((c) => {
    const routes = routesByCity.get(c.city) || [];
    const pointOwners = owners.get(c.id) || [];
    return {
      id: c.id,
      trade_name: c.trade_name,
      num_orders: counts.get(c.id) || 0,
      routes,
      routes_flattened: routes.join(', '),
      owners: pointOwners,
      owners_flattened: pointOwners.map((o) => o.name).join(', '),
    };
  });
}

module.exports = { contactsOrdersSummary, orderStatsPerContact, oneYearAgo };
