'use strict';

/**
 * quote controller (v5). v3 defaulted an empty pdf to the front's quote preview
 * (afterFindOne); that preview is gone (issues/160): the PDF button asks the API.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::quote.quote', () => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
