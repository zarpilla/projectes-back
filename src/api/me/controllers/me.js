'use strict';

/**
 * me controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::me.me', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port me.dir3SearchNif from v3 api/me/controllers/me.js
  async dir3SearchNif(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'me.dir3SearchNif not yet ported (Phase 4)' };
  },
  // TODO(P4): port me.dir3SearchName from v3 api/me/controllers/me.js
  async dir3SearchName(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'me.dir3SearchName not yet ported (Phase 4)' };
  },
}));
