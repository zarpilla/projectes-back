'use strict';

/**
 * activity-type controller (v5). Ported from v3 api/activity-type/controllers/activity-type.js.
 * Core CRUD is inherited from createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::activity-type.activity-type', ({ strapi }) => ({
  /**
   * GET /api/activity-types/basic
   * Slim projection (id, name, global) of all activity types.
   */
  async getBasic(ctx) {
    return strapi.db.query('api::activity-type.activity-type').findMany({
      select: ['id', 'name', 'global'],
      limit: -1,
    });
  },

  /**
   * GET /api/activity-types/global
   * Backfill: migrates the legacy singular `project` relation into `projects`.
   * The ETL (Phase 7) performs this on fresh v5 data; kept for API parity.
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
