'use strict';

/**
 * bank-rule controller (v5): «Conciliació › Regles» (issues/413).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::bank-rule.bank-rule', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
