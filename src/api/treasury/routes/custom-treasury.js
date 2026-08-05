'use strict';

/**
 * treasury CUSTOM routes (v5). Ported from v3 api/treasury/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/treasuries automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/forecast',
      handler: 'treasury.forecast',
    },
  ],
};
