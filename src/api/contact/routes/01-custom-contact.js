'use strict';

/**
 * contact CUSTOM routes (v5). Ported from v3 api/contacts/config/routes.json.
 * These are the 4 non-CRUD endpoints; their handlers are stubbed
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
      path: '/contacts/basic',
      handler: 'contact.basic',
    },
    {
      method: 'GET',
      path: '/contacts/withorders',
      handler: 'contact.withorders',
    },
    {
      method: 'GET',
      path: '/contacts/orders',
      handler: 'contact.orders',
    },
    {
      method: 'POST',
      path: '/contacts/unify',
      handler: 'contact.unify',
    },
  ],
};
