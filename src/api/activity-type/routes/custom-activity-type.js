'use strict';

/**
 * activity-type CUSTOM routes (v5). Ported from v3 api/activity-type/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/activity-types automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'activity-type.getBasic',
    },
    {
      method: 'GET',
      path: '/global',
      handler: 'activity-type.updateGlobal',
    },
  ],
};
