'use strict';

/**
 * incidence-category controller (v5): core CRUD, with the v3 query params the
 * front still sends (_limit, _sort…).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::incidence-category.incidence-category', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
