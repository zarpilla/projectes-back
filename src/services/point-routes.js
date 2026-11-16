'use strict';
/* global strapi */

/**
 * The routes of a delivery point (issues/351, La Diligència). A point takes
 * the routes of its town («Poblacions i rutes»), and the office can change
 * that for one point (point-route rows):
 *   - an extraordinary route (`extra`): a route that doesn't go to the town
 *     but stops at this point, with its own time slot for it if given;
 *   - a cancelled route (`cancelled`): a route of the town not offered there;
 *   - the main route (`main`, at most one): listed first and preselected.
 * The three combine (cancel Monday's, add Wednesday's and make it the main).
 * The front's copy is projectes-front src/domain/pointRoutes.js.
 *
 * A member's order to the point can only go on one of these routes, or on the
 * substitute of a closure of one of them on its day (issues/355). The office
 * and the staff can put any route (controllers/order.js routeRefusal).
 */
const { errors } = require('@strapi/utils');
const { relationId } = require('./relation-input');
const { createLookups, norm, isBlank } = require('../api/integration/services/lookups');
const { toQueryDay } = require('./date-fields');

const UID = 'api::point-route.point-route';
const SLOT_FIELDS = ['time_from', 'time_to', 'time_from_2', 'time_to_2'];

const idOf = (value) => (value && typeof value === 'object' ? value.id : value || null);
const has = (data, key) => Object.prototype.hasOwnProperty.call(data, key);
const blank = (v) => v === undefined || v === null || v === '';

/**
 * The routes a point is offered, in order: the main one first, then the
 * town's in the routes' order, then the extraordinary ones. Pure.
 * `townRoutes`: the town's active routes, in order; `rows`: the point's
 * point-route rows; `allRoutes`: every route, in order.
 * Returns [{ route, extra, main, row }].
 */
function effectiveRoutes({ townRoutes = [], rows = [], allRoutes = [] }) {
  const rowOf = new Map();
  for (const row of rows || []) {
    const id = idOf(row && row.route);
    if (id) rowOf.set(id, row);
  }
  const cancelled = (id) => Boolean(rowOf.get(id) && rowOf.get(id).cancelled);
  const list = [];
  const seen = new Set();
  for (const route of townRoutes) {
    if (!route || seen.has(route.id) || cancelled(route.id)) continue;
    seen.add(route.id);
    list.push({ route, extra: false });
  }
  for (const route of allRoutes) {
    const row = route && rowOf.get(route.id);
    if (!row || !row.extra || row.cancelled || seen.has(route.id) || route.active === false) continue;
    seen.add(route.id);
    list.push({ route, extra: true });
  }
  const result = list.map((item) => {
    const row = rowOf.get(item.route.id) || null;
    return { ...item, main: Boolean(row && row.main), row };
  });
  const main = result.findIndex((r) => r.main);
  if (main > 0) result.unshift(...result.splice(main, 1));
  return result;
}

/** The town's active routes, in the routes' order: { town, routes }. */
async function townRoutesOf(point, lookups) {
  const town = point && !isBlank(point.city) ? String(point.city).trim() : null;
  if (!town) return { town: null, routes: [] };
  const cityIds = new Set((await lookups.cities()).filter((c) => norm(c.name) === norm(town)).map((c) => c.id));
  if (!cityIds.size) return { town, routes: [] };
  const routeIds = new Set(
    (await lookups.cityRoutes()).filter((cr) => cityIds.has(idOf(cr.city))).map((cr) => idOf(cr.route)),
  );
  const routes = (await lookups.routes()).filter((r) => r.active && routeIds.has(r.id));
  return { town, routes };
}

/** The point-route rows of a point (route id populated). */
async function pointRouteRows(contactId) {
  if (!contactId) return [];
  return (
    (await strapi.db.query(UID).findMany({
      where: { contact: contactId },
      populate: { route: { select: ['id'] } },
    })) || []
  );
}

/**
 * The routes of a point (`point`: a contact row with id and city, or its id):
 * { town, routes: effectiveRoutes(…), rows }.
 */
async function pointRoutesOf(point, lookups = createLookups()) {
  const contact =
    point && typeof point === 'object'
      ? point
      : await strapi.db.query('api::contact.contact').findOne({ where: { id: point }, select: ['id', 'city'] });
  if (!contact) return { town: null, routes: [], rows: [] };
  const [{ town, routes: townRoutes }, rows, allRoutes] = await Promise.all([
    townRoutesOf(contact, lookups),
    pointRouteRows(contact.id),
    lookups.routes(),
  ]);
  return { town, routes: effectiveRoutes({ townRoutes, rows, allRoutes }), rows };
}

/**
 * Why a member can't send an order to `contactId` on `routeId` on `date`, or
 * null: the route is one of the point's, or the substitute on that day of a
 * closure of one of them (issues/355).
 */
async function pointRouteRefusal({ contactId, routeId, date, field = 'ruta' }) {
  if (!contactId || !routeId) return null;
  const { town, routes } = await pointRoutesOf(contactId);
  const ids = routes.map((r) => r.route.id);
  if (ids.includes(routeId)) return null;
  const day = date ? toQueryDay(date) : null;
  if (day && ids.length) {
    const substitute = await strapi.db.query('api::route-festive.route-festive').findOne({
      where: { route: { id: { $in: ids } }, substitute_route: routeId, substitute_date: day },
      select: ['id'],
    });
    if (substitute) return null;
  }
  const route = await strapi.db.query('api::route.route').findOne({ where: { id: routeId }, select: ['id', 'name'] });
  const name = route ? ` «${route.name}»` : '';
  return town
    ? `La ${field}${name} no passa pel punt d'entrega (${town}). Tria'n una de les que s'hi ofereixen.`
    : `La ${field}${name} no passa pel punt d'entrega. Tria'n una de les que s'hi ofereixen.`;
}

/**
 * Checks and tidies a point-route create/update (`data`, mutated); `stored`
 * is the row on update.
 */
async function checkPointRoute(data, stored = null) {
  if (!data) return;
  const prev = stored || {};
  const value = (key) => (has(data, key) ? data[key] : prev[key]);
  const contactId = has(data, 'contact') ? relationId(data.contact) : idOf(prev.contact);
  const routeId = has(data, 'route') ? relationId(data.route) : idOf(prev.route);
  if (!contactId) throw new errors.ValidationError("Cal indicar el punt d'entrega");
  if (!routeId) throw new errors.ValidationError('Cal indicar la ruta');

  const extra = Boolean(value('extra'));
  const cancelled = Boolean(value('cancelled'));
  const main = Boolean(value('main'));
  if (cancelled && (extra || main)) {
    throw new errors.ValidationError('Una ruta anul·lada no pot ser extraordinària ni principal');
  }
  if (!extra && !cancelled && !main) {
    throw new errors.ValidationError('Cal marcar la ruta com a extraordinària, principal o anul·lada');
  }
  // the point's own time slot is only for an extraordinary route
  if (!extra) for (const key of SLOT_FIELDS) data[key] = null;
  for (const key of SLOT_FIELDS) {
    if (!has(data, key)) continue;
    if (data[key] === '') data[key] = null;
    // «15:00» as Strapi stores a time
    else if (typeof data[key] === 'string' && /^\d{1,2}:\d{2}$/.test(data[key])) data[key] = `${data[key].padStart(5, '0')}:00.000`;
  }
  if (extra) {
    const pairs = [
      ['time_from', 'time_to'],
      ['time_from_2', 'time_to_2'],
    ];
    for (const [from, to] of pairs) {
      if (blank(value(from)) !== blank(value(to))) {
        throw new errors.ValidationError("Cal indicar l'hora d'inici i la de final de la franja");
      }
    }
  }

  const twins = await strapi.db.query(UID).findMany({
    where: { contact: contactId, route: routeId },
    select: ['id'],
  });
  if ((twins || []).some((t) => t.id !== prev.id)) {
    throw new errors.ValidationError("Aquest punt d'entrega ja té aquesta ruta configurada");
  }
}

/** A point has one main route at most: setting one unsets the others. */
async function clearOtherMains(row) {
  if (!row || !row.main) return;
  const full = await strapi.db.query(UID).findOne({ where: { id: row.id }, populate: { contact: { select: ['id'] } } });
  const contactId = full && idOf(full.contact);
  if (!contactId) return;
  const others = await strapi.db.query(UID).findMany({
    where: { contact: contactId, main: true, id: { $ne: row.id } },
    select: ['id', 'extra', 'cancelled'],
  });
  for (const other of others || []) {
    // a row that was only the main one has nothing left to say
    if (!other.extra && !other.cancelled) await strapi.db.query(UID).delete({ where: { id: other.id } });
    else await strapi.db.query(UID).update({ where: { id: other.id }, data: { main: false } });
  }
}

module.exports = {
  effectiveRoutes,
  townRoutesOf,
  pointRouteRows,
  pointRoutesOf,
  pointRouteRefusal,
  checkPointRoute,
  clearOtherMains,
};
