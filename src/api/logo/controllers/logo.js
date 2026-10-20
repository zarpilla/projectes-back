'use strict';

/**
 * logo controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { rememberLogos, logosCacheKey } = require('../../../services/logos-cache');

module.exports = createCoreController('api::logo.logo', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  // Served from memory until a logo is written (issues/308). The key is taken
  // before adaptCtxQuery rewrites the query.
  async find(ctx) {
    const key = logosCacheKey(ctx);
    return rememberLogos(key, () => {
      adaptCtxQuery(ctx);
      return super.find(ctx);
    });
  },

  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
