'use strict';

/**
 * received-expense CUSTOM routes (v5). Ported from v3 api/received-expense/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/received-expenses automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'received-expense.findBasic',
    },
    {
      method: 'POST',
      path: '/upload',
      handler: 'received-expense.upload',
    },
  ],
};
