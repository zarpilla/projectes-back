'use strict';

/**
 * v5 mounts custom routes at /api + the path exactly as written, and the core
 * router's `/<plural>/:id` would otherwise shadow a static path, so this file
 * sorts before the core route file by name.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/city-routes/basic',
      handler: 'city-route.basic',
    },
  ],
};
