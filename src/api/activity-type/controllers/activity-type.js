'use strict';

/**
 * activity-type controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::activity-type.activity-type', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port activity-type.getBasic from v3 api/activity-type/controllers/activity-type.js
  async getBasic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity-type.getBasic not yet ported (Phase 4)' };
  },
  // TODO(P4): port activity-type.updateGlobal from v3 api/activity-type/controllers/activity-type.js
  async updateGlobal(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity-type.updateGlobal not yet ported (Phase 4)' };
  },
}));
