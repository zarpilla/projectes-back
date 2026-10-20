'use strict';

/**
 * The read cache's administration (issues/307): what it holds and how it
 * behaves, and «Buida la memòria cau» for a change it can't see (none is
 * expected: it would show as a mismatch with READ_CACHE_VERIFY).
 * App admins only.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/read-cache/stats',
      handler: 'read-cache.stats',
      config: { policies: ['global::isAdmin'] },
    },
    {
      method: 'POST',
      path: '/read-cache/clear',
      handler: 'read-cache.clear',
      config: { policies: ['global::isAdmin'] },
    },
  ],
};
