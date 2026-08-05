'use strict';

/**
 * incidence CUSTOM routes (v5). Ported from v3 api/incidences/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/incidences automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/infoall',
      handler: 'incidence.infoAll',
    },
  ],
};
