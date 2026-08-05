'use strict';

/**
 * project-original-phas CUSTOM routes (v5). Ported from v3 api/project-original-phases/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/project-original-phases automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/project-original-phases-hours',
      handler: 'project-original-phas.findWithHours',
    },
  ],
};
