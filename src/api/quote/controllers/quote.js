'use strict';
/* global strapi */

/**
 * quote controller (v5). findOne override ports the v3 afterFindOne hook
 * (v5 removed afterFindOne): defaults the pdf field to the frontend quote URL.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::quote.quote', ({ strapi }) => ({
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
