'use strict';
/* global strapi */

/**
 * member-notice controller (issues/430): everyone reads only her own notices
 * and only marks them read.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

const UID = 'api::member-notice.member-notice';

module.exports = createCoreController(UID, () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();
    const filters = ctx.query.filters || {};
    ctx.query = { ...ctx.query, filters: { $and: [filters, { user: { id: user.id } }] } };
    return super.find(ctx);
  },

  async update(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();
    const id = ctx.params.id;
    const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
    const row = await strapi.db.query(UID).findOne({ where, populate: { user: { select: ['id'] } } });
    if (!row || !row.user || row.user.id !== user.id) return ctx.notFound();
    const body = ctx.request.body || {};
    const payload = body.data && typeof body.data === 'object' ? body.data : body;
    ctx.request.body = { data: { read: payload.read !== false } };
    return super.update(ctx);
  },
}));
