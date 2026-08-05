'use strict';

/**
 * phase-expense CUSTOM routes (v5). Ported from v3 api/phase-expense/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/phase-expenses automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/assigned',
      handler: 'phase-expense.findAssigned',
    },
  ],
};
