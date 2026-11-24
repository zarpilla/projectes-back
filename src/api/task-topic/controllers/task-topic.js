'use strict';

/**
 * task-topic controller (v5): core CRUD, with the v3 query params the front
 * still sends (_limit, _sort…). «Temes de tasca» (issues/461).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::task-topic.task-topic', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
