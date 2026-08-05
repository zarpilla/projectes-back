'use strict';

/**
 * activity controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::activity.activity', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port activity.totalByDay from v3 api/activity/controllers/activity.js
  async totalByDay(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity.totalByDay not yet ported (Phase 4)' };
  },
  // TODO(P4): port activity.getForCalendar from v3 api/activity/controllers/activity.js
  async getForCalendar(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity.getForCalendar not yet ported (Phase 4)' };
  },
  // TODO(P4): port activity.importCalendar from v3 api/activity/controllers/activity.js
  async importCalendar(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity.importCalendar not yet ported (Phase 4)' };
  },
  // TODO(P4): port activity.move from v3 api/activity/controllers/activity.js
  async move(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity.move not yet ported (Phase 4)' };
  },
  // TODO(P4): port activity.import from v3 api/activity/controllers/activity.js
  async importData(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'activity.import not yet ported (Phase 4)' };
  },
}));
