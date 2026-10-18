'use strict';
/* global strapi */

/**
 * The days a route runs: every weekday it has ticked, except the days it is
 * closed. A closure is a route-festive row («Rutes i dies»): with a route it
 * closes that route, without one it closes them all. The entity's holidays
 * don't close a route by themselves (they are closed from «Rutes i dies»).
 *
 * Same rule as the front's assignRouteDate / checkIfDateIsValidInroute
 * (src/service/assignRouteRate.js). The collection and transfer dates took
 * the route's first weekday only and ignored the closures (issues/156).
 */

const moment = require('moment');

// moment's day(): Sunday is 0
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);
const ymd = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  return moment(value).format('YYYY-MM-DD');
};

// the weekdays (day() numbers) the route runs on
const routeWeekdays = (route) => (route ? WEEKDAYS.flatMap((key, day) => (route[key] ? [day] : [])) : []);

const isRouteClosed = (route, date, closures = []) => {
  const day = ymd(date);
  const routeId = idOf(route);
  return (closures || []).some((c) => ymd(c.date) === day && (!idOf(c.route) || idOf(c.route) === routeId));
};

// the route runs on `date` and is not closed that day
const routeRunsOn = (route, date, closures = []) =>
  routeWeekdays(route).includes(moment(date).day()) && !isRouteClosed(route, date, closures);

// the closures between two dates (YYYY-MM-DD), route populated
const loadRouteClosures = async (from, to) =>
  (await strapi.db.query('api::route-festive.route-festive').findMany({
    where: { date: { $gte: ymd(from), $lte: ymd(to) } },
    populate: { route: true },
  })) || [];

// a year of closures at most
const MAX_DAYS = 366;

// the first day after `after` (default today) the route runs and is open
// (YYYY-MM-DD), or null when it has no weekday
const nextRouteDay = async (route, { after = moment(), closures } = {}) => {
  if (!routeWeekdays(route).length) return null;
  const start = moment(ymd(after), 'YYYY-MM-DD');
  const list =
    closures || (await loadRouteClosures(start, start.clone().add(MAX_DAYS, 'days')));
  const day = start.clone();
  for (let i = 0; i < MAX_DAYS; i++) {
    day.add(1, 'day');
    if (routeRunsOn(route, day, list)) return day.format('YYYY-MM-DD');
  }
  return null;
};

module.exports = { routeWeekdays, isRouteClosed, routeRunsOn, loadRouteClosures, nextRouteDay };
