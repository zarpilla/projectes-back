'use strict';
/* global strapi */

/**
 * task-comment controller (v5). The author is whoever writes it; only they can
 * edit or delete it. Mentioned people (`mentions`, ids picked with @ in the front)
 * get an email a few minutes later, if the comment is still there (services/notify.js).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { notifyMentioned } = require('../../task/services/notify');

const UID = 'api::task-comment.task-comment';

async function isAuthor(ctx) {
  const row = await strapi.db.query(UID).findOne({ where: { documentId: ctx.params.id }, populate: { author: true } });
  return row && row.author && ctx.state.user && row.author.id === ctx.state.user.id;
}

module.exports = createCoreController(UID, ({ strapi }) => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  async create(ctx) {
    const body = ctx.request.body || {};
    const data = body.data || {};
    if (!ctx.state.user) return ctx.unauthorized();
    data.author = ctx.state.user.id;
    ctx.request.body = { ...body, data };
    const response = await super.create(ctx);
    try {
      const comment = await strapi.db.query(UID).findOne({
        where: { id: response.data.id },
        populate: { mentions: true, task: { populate: { project: true } } },
      });
      const people = (comment.mentions || []).filter((u) => u.id !== ctx.state.user.id && u.email);
      if (comment.task) await notifyMentioned(comment.task, comment, people, ctx.state.user);
    } catch (error) {
      strapi.log.error(`task comment mention email: ${error.message}`);
    }
    return response;
  },

  async update(ctx) {
    if (!(await isAuthor(ctx))) return ctx.forbidden('Només qui ha escrit el comentari el pot editar');
    const body = ctx.request.body || {};
    // only the text changes
    ctx.request.body = { ...body, data: { text: (body.data || {}).text } };
    return super.update(ctx);
  },

  async delete(ctx) {
    if (!(await isAuthor(ctx))) return ctx.forbidden('Només qui ha escrit el comentari el pot esborrar');
    return super.delete(ctx);
  },
}));
