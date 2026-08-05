'use strict';

/**
 * contact CUSTOM routes (v5). Ported from v3 api/contacts/config/routes.json.
 * These are the 4 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/contacts automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'contact.basic',
    },
    {
      method: 'GET',
      path: '/withorders',
      handler: 'contact.withorders',
    },
    {
      method: 'GET',
      path: '/orders',
      handler: 'contact.orders',
    },
    {
      method: 'POST',
      path: '/unify',
      handler: 'contact.unify',
    },
  ],
};
