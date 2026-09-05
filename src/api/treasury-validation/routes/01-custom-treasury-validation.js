'use strict';

/**
 * treasury-validation CUSTOM routes (v5). Ported from v3 api/treasury-validation/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
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
      method: 'POST',
      path: '/treasury-validations/toggle',
      handler: 'treasury-validation.toggle',
    },
    {
      method: 'GET',
      path: '/treasury-validations/:entity_type/:entity_id/:sub_type?',
      handler: 'treasury-validation.findByKey',
    },
  ],
};
