'use strict';

/**
 * me CUSTOM routes (v5). Ported from v3 api/me/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/me-setting automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/me/dir3/search/nif/:nif',
      handler: 'me.dir3SearchNif',
    },
    {
      method: 'GET',
      path: '/me/dir3/search/name/:name',
      handler: 'me.dir3SearchName',
    },
  ],
};
