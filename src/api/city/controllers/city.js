'use strict';

/**
 * city controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { townPostcodes } = require('../services/town-postcodes');

module.exports = createCoreController('api::city.city', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/cities/postcodes — { town: postcode }, the code the contacts of
   * each town use most (issues/182). Keys are the town in lower case, without
   * accents.
   */
  async postcodes() {
    const { tableName } = strapi.db.metadata.get('api::contact.contact');
    const rows = await strapi.db.connection(tableName).select('city', 'postcode').whereNotNull('postcode');
    return townPostcodes(rows);
  },

  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
