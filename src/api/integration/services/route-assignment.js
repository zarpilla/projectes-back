'use strict';
/* global strapi */

/**
 * The route of an order sent without one (integrations API, the user's
 * decision 2026-10-30): the member gives the day she wants, and the order goes
 * on a route of the delivery point's town that runs that day, or on the first
 * day after it that one does.
 *
 * - The town's routes are those of «Poblacions i rutes» (city-route) for the
 *   point's town, changed for the point by the office (issues/351: cancelled
 *   ones out, extraordinary ones in, the main one first on its day), matched by name, and active, like the order form's
 *   validCityRoutes (a route that also does transfers, is_transfer_route, is
 *   one of them: La Garriga only has such routes); with several on the same
 *   day, the first in the routes' order.
 * - A route runs on its weekdays unless «Rutes i dies» closes it that day
 *   (route-days.js). A closure with a substitute route and day (issues/355)
 *   puts the substitute on that day for the town, which a member can choose
 *   from SUBSTITUTE_DAYS_BEFORE days before, as in the order form.
 */
const moment = require('moment');
const { routeRunsOn } = require('../../order/services/route-days');
const { pointRoutesOf } = require('../../../services/point-routes');
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

/**
 * The delivery point's routes: its town's, less the ones the office cancelled
 * there, plus the extraordinary ones (issues/351): { town, routes, mainId }.
 */
async function townRoutesOf(point, lookups) {
  const { town, routes } = await pointRoutesOf(point, lookups);
  const main = routes.find((r) => r.main);
  return { town, routes: routes.map((r) => r.route), mainId: main ? main.route.id : null };
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
  const { town, routes, mainId } = await townRoutesOf(point, lookups);
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
      // the point's main route first (issues/351), then the routes' order
      const rank = (r) => (r.id === mainId ? -1 : (order.get(r.id) ?? 0));
      candidates.sort((a, b) => rank(a) - rank(b));
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
