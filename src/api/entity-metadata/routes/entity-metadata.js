'use strict';

/**
 * entity-metadata routes (v5). Single custom endpoint, admin-gated.
 * Ported from v3 api/entity-metadata/config/routes.json.
 *
 * This API has no content-type — it is a pure schema-introspection endpoint.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/entity-metadata/admin-entities',
      handler: 'entity-metadata.adminEntities',
      config: {
        // v5: authentication is declared via `auth` (the users-permissions strategy),
        // not via a `plugins::users-permissions.isAuthenticated` policy (removed in v4+).
        auth: { strategy: 'users-permissions' },
        policies: ['global::isAdmin'],
      },
    },
  ],
};
