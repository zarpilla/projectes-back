'use strict';
/* global strapi */

/**
 * quote controller (v5). findOne override ports the v3 afterFindOne hook
 * (v5 removed afterFindOne): defaults the pdf field to the frontend quote URL.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { numericId } = require('../../../middlewares/v3-compat');
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { getFrontUrl } = require('../../../services/me-settings');

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
      const frontUrl = await getFrontUrl();
      if (frontUrl) {
        quote.pdf = `${frontUrl}quote/${numericId(ctx)}`;
      }
    }
    return response;
  },
}));
