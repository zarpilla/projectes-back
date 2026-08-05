'use strict';

/**
 * activity-type controller (v5). Ported from v3 api/activity-type/controllers/activity-type.js.
 * Core CRUD is inherited from createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::activity-type.activity-type', ({ strapi }) => ({
  /**
   * GET /api/activity-types/basic
   * Returns a slim projection (id, name, global) of all activity types.
   * v3 used Bookshelf `.model.query(qb => qb.select(...)).fetchAll()`; v5 uses
   * db.query with a fields selection (the Bookshelf `.select` has no direct v5
   * Document Service equivalent for column projection — db.query covers it).
   */
  async getBasic(ctx) {
    const rows = await strapi.db.query('api::activity-type.activity-type').findMany({
      select: ['id', 'name', 'global'],
      limit: -1,
    });
    // v5 db.query returns plain objects (already sanitized to the selected fields);
    // no sanitizeEntity needed (removed in v5).
    return rows;
  },

  /**
   * GET /api/activity-types/global
   * Backfill: for each activity type that has a legacy singular `project` relation,
   * migrate it into the `projects` many-relation collection.
   *
   * NOTE: this is a one-time migration helper. In the clean-room v5 build the ETL
   * (Phase 7) performs this transformation during data load, so this endpoint is
   * effectively a no-op on fresh data. Kept for parity with the v3 API surface.
   */
  async updateGlobal(ctx) {
    const acTypes = await strapi.db.query('api::activity-type.activity-type').findMany({
      populate: { project: true, projects: true },
      limit: -1,
    });

    let updated = 0;
    for (const ac of acTypes) {
      if (ac.project && ac.project.id) {
        await strapi.db.query('api::activity-type.activity-type').update({
          where: { id: ac.id },
          data: { projects: [ac.project.id] },
        });
        updated++;
      }
    }
    return { migrated: updated, total: acTypes.length };
  },
}));
