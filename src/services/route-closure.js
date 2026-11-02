'use strict';

/**
 * A route closure (route-festive, «Rutes i dies») with its reason and, when
 * the route runs another day instead, the substitute route and its date
 * (issues/354, 355). The holidays don't close any route by themselves: the
 * office closes it by hand and says why and where the orders go.
 *
 * The members choose the substitute route for the towns of the closed route
 * only on its date, from SUBSTITUTE_DAYS_BEFORE days before (the front's
 * src/domain/routeClosures.js).
 */
const { errors } = require('@strapi/utils');
const { relationId } = require('./relation-input');

const ymd = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
};

/**
 * Checks and tidies the fields a create/update sends (`data`, mutated);
 * `stored` is the row on update. A substitute route needs its date, and a date
 * needs a route.
 */
function checkClosure(data, stored = null) {
  if (!data) return;
  if (typeof data.reason === 'string') data.reason = data.reason.trim() || null;
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
  const prev = stored || {};

  let routeId;
  if (has('substitute_route')) {
    const v = data.substitute_route;
    routeId = v === '' ? null : (relationId(v) ?? null);
    if (routeId === null) data.substitute_route = null;
  } else {
    routeId = relationId(prev.substitute_route) ?? null;
  }
  const date = has('substitute_date') ? ymd(data.substitute_date) : ymd(prev.substitute_date);
  if (has('substitute_date')) data.substitute_date = date;

  if (routeId && !date) throw new errors.ValidationError('Cal indicar el dia de la ruta alternativa');
  if (!routeId && date) throw new errors.ValidationError('Cal indicar la ruta alternativa');
  const closed = has('date') ? ymd(data.date) : ymd(prev.date);
  const closedRoute = has('route') ? relationId(data.route) : relationId(prev.route);
  if (routeId && date && closed === date && routeId === closedRoute) {
    throw new errors.ValidationError('La ruta alternativa no pot ser la mateixa ruta el mateix dia que es tanca');
  }
}

module.exports = { checkClosure };
