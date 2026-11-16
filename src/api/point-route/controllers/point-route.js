'use strict';

/**
 * point-route controller (v5): core CRUD, with the v3 query params the front
 * still sends (_limit, _where…). See services/point-routes.js.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

// the point and the route by name only: the rows are read by every member
const POPULATE = {
  contact: { fields: ['id', 'name', 'trade_name', 'city'] },
  route: { fields: ['id', 'name', 'short_name', 'active'] },
};

module.exports = createCoreController('api::point-route.point-route', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    ctx.query = { ...ctx.query, populate: POPULATE };
    return super.find(ctx);
  },
  async findOne(ctx) {
    ctx.query = { ...ctx.query, populate: POPULATE };
    return super.findOne(ctx);
  },
  async create(ctx) {
    ctx.query = { ...ctx.query, populate: POPULATE };
    return super.create(ctx);
  },
  async update(ctx) {
    ctx.query = { ...ctx.query, populate: POPULATE };
    return super.update(ctx);
  },
}));
