'use strict';
/* global strapi */

/**
 * quote controller (v5). findOne override ports the v3 afterFindOne hook
 * (v5 removed afterFindOne): defaults the pdf field to the frontend quote URL.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::quote.quote', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    const quote = response?.data?.attributes || response?.data;
    if (quote && !quote.pdf) {
      const config = await strapi.documents('api::config.config').findFirst();
      if (config?.front_url) {
        quote.pdf = `${config.front_url}quote/${ctx.params.id}`;
      }
    }
    return response;
  },
}));
