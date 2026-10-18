'use strict';

/**
 * form-submission controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::form-submission.form-submission', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * POST /api/form-submissions («Contacta»): the sender is the logged user,
   * whatever the body says (issues/167).
   */
  async create(ctx) {
    const body = ctx.request.body || {};
    const payload = body.data && typeof body.data === 'object' ? body.data : body;
    payload.user = ctx.state.user ? ctx.state.user.id : null;
    return super.create(ctx);
  },

  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
