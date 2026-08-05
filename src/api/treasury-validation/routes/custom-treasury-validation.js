'use strict';

/**
 * treasury-validation CUSTOM routes (v5). Ported from v3 api/treasury-validation/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/treasury-validations automatically.
 */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/toggle',
      handler: 'treasury-validation.toggle',
    },
    {
      method: 'GET',
      path: '/:entity_type/:entity_id/:sub_type?',
      handler: 'treasury-validation.findByKey',
    },
  ],
};
