'use strict';

/** GET /api/read-cache/stats, POST /api/read-cache/clear (issues/307). */
const { getReadCache } = require('../../../services/read-cache');

module.exports = ({ strapi }) => ({
  async stats() {
    return getReadCache().stats();
  },

  async clear(ctx) {
    const cache = getReadCache();
    const entries = cache.entries.size;
    cache.clear('cleared by an admin');
    strapi.log.info(
      `[read-cache] cleared by user ${ctx.state.user && ctx.state.user.id} (${entries} entries)`,
    );
    return { cleared: entries };
  },
});
