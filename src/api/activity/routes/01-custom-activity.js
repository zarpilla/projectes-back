'use strict';

/**
 * activity CUSTOM routes (v5). Ported from v3 api/activity/config/routes.json.
 * These are the 5 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 mounts custom routes at /api + the path exactly as written — it does NOT
 * namespace them by content type, so each path keeps its v3 plural prefix.
 * The `01-` filename prefix matters: route files load in alphabetical order and
 * the core router's `/<plural>/:id` would otherwise shadow static paths like
 * `/<plural>/basic`.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/activities/total-by-day',
      handler: 'activity.totalByDay',
    },
    {
      method: 'GET',
      path: '/activities/calendar',
      handler: 'activity.getForCalendar',
    },
    {
      method: 'GET',
      path: '/activities/import-calendar/:id',
      handler: 'activity.importCalendar',
    },
    {
      method: 'POST',
      path: '/activities/move',
      handler: 'activity.move',
    },
    {
      method: 'GET',
      path: '/activities/import',
      handler: 'activity.importData',
    },
  ],
};
