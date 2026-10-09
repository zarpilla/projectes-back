'use strict';

/**
 * document-change-log controller (v5). Core find/findOne only (see routes).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::document-change-log.document-change-log', () => ({
  // v3 query-param compatibility: the views query with _where/_sort/_limit.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
