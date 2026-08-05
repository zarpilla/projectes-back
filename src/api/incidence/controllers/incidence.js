'use strict';

/**
 * incidence controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::incidence.incidence', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port incidences.infoAll from v3 api/incidences/controllers/incidences.js
  async infoAll(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'incidence.infoAll not yet ported (Phase 4)' };
  },
}));
