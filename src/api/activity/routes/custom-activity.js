'use strict';

/**
 * activity CUSTOM routes (v5). Ported from v3 api/activity/config/routes.json.
 * These are the 5 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/activities automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/total-by-day',
      handler: 'activity.totalByDay',
    },
    {
      method: 'GET',
      path: '/calendar',
      handler: 'activity.getForCalendar',
    },
    {
      method: 'GET',
      path: '/import-calendar/:id',
      handler: 'activity.importCalendar',
    },
    {
      method: 'POST',
      path: '/move',
      handler: 'activity.move',
    },
    {
      method: 'GET',
      path: '/import',
      handler: 'activity.importData',
    },
  ],
};
