'use strict';

/**
 * city-route controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { BASIC_SELECT, BASIC_POPULATE } = require('../services/basic-shape');

module.exports = createCoreController('api::city-route.city-route', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/city-routes/basic
   * The list every screen reads: row id, city id, route id and name.
   * A custom route, so it returns db.query rows without the sanitise pass.
   */
  async basic() {
    return strapi.db.query('api::city-route.city-route').findMany({
      select: BASIC_SELECT,
      populate: BASIC_POPULATE,
    });
  },

  // Default core actions (find/findOne/create/update/delete) are inherited.
}));
