'use strict';

/**
 * me CUSTOM routes (v5). Ported from v3 api/me/config/routes.json.
 * These are the non-CRUD endpoints: the DIR3 proxies (ported from v3) and
 * tickets-login (login link to the tickets site, issues/019).
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
      path: '/me/dir3/search/nif/:nif',
      handler: 'me.dir3SearchNif',
    },
    {
      method: 'GET',
      path: '/me/dir3/search/name/:name',
      handler: 'me.dir3SearchName',
    },
    {
      method: 'GET',
      path: '/me/tickets-login',
      handler: 'me.ticketsLogin',
    },
  ],
};
