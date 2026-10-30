'use strict';
/* global strapi */

/**
 * The route of an order sent without one (integrations API, the user's
 * decision 2026-10-30): the member gives the day she wants, and the order goes
 * on a route of the delivery point's town that runs that day, or on the first
 * day after it that one does.
 *
 * - The town's routes are those of «Poblacions i rutes» (city-route) for the
 *   point's town, matched by name like the order form does, active and not
 *   transfer routes; with several on the same day, the first in the routes'
 *   order.
 * - A route runs on its weekdays unless «Rutes i dies» closes it that day
 *   (route-days.js). A closure with a substitute route and day (issues/355)
 *   puts the substitute on that day for the town, which a member can choose
 *   from SUBSTITUTE_DAYS_BEFORE days before, as in the order form.
 */
const moment = require('moment');
const { routeRunsOn } = require('../../order/services/route-days');
const { norm, isBlank } = require('./lookups');
const { reject } = require('./sync-common');

// the order form's SUBSTITUTE_DAYS_BEFORE (front src/domain/routeClosures.js)
const SUBSTITUTE_DAYS_BEFORE = 10;
// how far a day is looked for
const MAX_DAYS = 60;

const idOf = (value) => (value && typeof value === 'object' ? value.id : value || null);
const ymd = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return moment(value).format('YYYY-MM-DD');
};

/** The town's routes, in the routes' order, for a delivery point: { town, routes }. */
async function townRoutesOf(point, lookups) {
  const town = point && !isBlank(point.city) ? String(point.city).trim() : null;
  if (!town) return { town: null, routes: [] };
  const cityIds = new Set(
    (await lookups.cities()).filter((c) => norm(c.name) === norm(town)).map((c) => c.id),
  );
  if (!cityIds.size) return { town, routes: [] };
  const routeIds = new Set(
    (await lookups.cityRoutes()).filter((cr) => cityIds.has(idOf(cr.city))).map((cr) => idOf(cr.route)),
  );
  const routes = (await lookups.routes()).filter(
    (r) => r.active && !r.is_transfer_route && routeIds.has(r.id),
  );
  return { town, routes };
}

async function loadClosures(from, to) {
  return (
    (await strapi.db.query('api::route-festive.route-festive').findMany({
      where: {
        $or: [{ date: { $gte: from, $lte: to } }, { substitute_date: { $gte: from, $lte: to } }],
      },
      populate: { route: { select: ['id'] }, substitute_route: { select: ['id'] } },
    })) || []
  );
}

/**
 * The route and day for an order to `point` wanted on `from` (YYYY-MM-DD) or
 * later: { route, date, moved }. `today` is the tenant's day.
 */
async function assignRouteDay(point, from, { lookups, today }) {
  const { town, routes } = await townRoutesOf(point, lookups);
  if (!routes.length) {
    reject(
      'TOWN_WITHOUT_ROUTES',
      town
        ? `La població «${town}» del punt d'entrega no té cap ruta. Parla amb l'oficina.`
        : "El punt d'entrega no té població",
      { field: 'delivery_point' },
    );
  }
  const allRoutes = await lookups.routes();
  const order = new Map(allRoutes.map((r, i) => [r.id, i]));
  const townIds = new Set(routes.map((r) => r.id));
  const last = moment(from, 'YYYY-MM-DD').add(MAX_DAYS, 'days').format('YYYY-MM-DD');
  const closures = await loadClosures(from, last);
  const now = moment(today, 'YYYY-MM-DD');

  const day = moment(from, 'YYYY-MM-DD');
  for (let i = 0; i <= MAX_DAYS; i++, day.add(1, 'day')) {
    const date = day.format('YYYY-MM-DD');
    const running = routes.filter((r) => routeRunsOn(r, date, closures));
    // the substitutes of the town's routes closed some day, on their own day
    const substituteOpen = !now.isBefore(day.clone().subtract(SUBSTITUTE_DAYS_BEFORE, 'days'), 'day');
    const substitutes = substituteOpen
      ? closures
          .filter(
            (c) => townIds.has(idOf(c.route)) && idOf(c.substitute_route) && ymd(c.substitute_date) === date,
          )
          .map((c) => allRoutes.find((r) => r.id === idOf(c.substitute_route)))
          .filter((r) => r && r.active)
      : [];
    const candidates = [...running, ...substitutes];
    if (candidates.length) {
      candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { route: candidates[0], date, moved: date !== from };
    }
  }
  return reject(
    'NO_ROUTE_DAY',
    `Cap ruta de ${town} no surt en els ${MAX_DAYS} dies des del ${moment(from).format('DD/MM/YYYY')}`,
    { field: 'estimated_delivery_date' },
  );
}

module.exports = { assignRouteDay, townRoutesOf, SUBSTITUTE_DAYS_BEFORE, MAX_DAYS };
