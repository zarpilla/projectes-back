'use strict';

/**
 * task CUSTOM routes (v5). Ported from v3 api/task/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/tasks automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/email',
      handler: 'task.email',
    },
  ],
};
