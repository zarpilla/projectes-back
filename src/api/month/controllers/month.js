'use strict';

/**
 * month controller (v5). Ported from v3 api/month/models/month.js afterFind hook.
 * v5 removed afterFind/afterFindOne hooks, so the default sort-by-month behavior
 * (applied when no explicit _sort/sort is requested) moves into the find override.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::month.month', ({ strapi }) => ({
  async find(ctx) {
    // If the caller did not request a specific sort, sort by month number.
    const hasSort = ctx.query.sort !== undefined || ctx.query._sort !== undefined;
    if (!hasSort && ctx.query.pagination === undefined) {
      // Unsorted, unpaginated find: return months sorted by month number.
      const rows = await strapi.db.query('api::month.month').findMany({
        orderBy: { month: 'asc' },
      });
      return this.transformResponse(rows);
    }
    return super.find(ctx);
  },
}));
