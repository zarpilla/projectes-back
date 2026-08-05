'use strict';

/**
 * contact controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::contact.contact', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port contacts.basic from v3 api/contacts/controllers/contacts.js
  async basic(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'contact.basic not yet ported (Phase 4)' };
  },
  // TODO(P4): port contacts.withorders from v3 api/contacts/controllers/contacts.js
  async withorders(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'contact.withorders not yet ported (Phase 4)' };
  },
  // TODO(P4): port contacts.orders from v3 api/contacts/controllers/contacts.js
  async orders(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'contact.orders not yet ported (Phase 4)' };
  },
  // TODO(P4): port contacts.unify from v3 api/contacts/controllers/contacts.js
  async unify(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'contact.unify not yet ported (Phase 4)' };
  },
}));
