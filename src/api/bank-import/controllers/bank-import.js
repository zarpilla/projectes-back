'use strict';

/**
 * bank-import controller (v5): the uploaded Norma 43 statements of
 * «Conciliació» (issues/413). They are created by POST /bank-movements/import.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::bank-import.bank-import', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
