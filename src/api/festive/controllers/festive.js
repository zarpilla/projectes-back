'use strict';

/**
 * festive controller (v5). Core CRUD is provided by createCoreController.
 *
 * Holidays of a non-personal type (Festiu Estatal, Festiu Catalunya…) are for
 * everyone: only an admin creates, changes or deletes them (issues/140). A
 * personal one (vacances, festiu local…) stays open to the hours screens.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { relationId } = require('../../../services/relation-input');
const { isAppAdmin } = require('../../../services/app-permissions');

const FORBIDDEN = 'Només una persona administradora pot canviar els festius de totes';

module.exports = createCoreController('api::festive.festive', ({ strapi }) => {
  const isPersonalType = async (typeId) => {
    if (!typeId) return true;
    const type = await strapi.db.query('api::festive-type.festive-type').findOne({ where: { id: typeId } });
    return !type || type.personal !== false;
  };

  const requestedType = (ctx) => {
    const body = (ctx.request && ctx.request.body) || {};
    const data = body.data || body;
    return data.festive_type === undefined ? undefined : relationId(data.festive_type);
  };

  const storedType = async (ctx) => {
    const id = ctx.params && ctx.params.id;
    if (!id) return null;
    const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
    const festive = await strapi.db.query('api::festive.festive').findOne({ where, populate: ['festive_type'] });
    return festive && festive.festive_type ? festive.festive_type.id : null;
  };

  // true when the request touches a holiday for everyone and the user is not an admin
  const refused = async (ctx, typeIds) => {
    for (const typeId of typeIds) {
      if (typeId !== undefined && !(await isPersonalType(typeId))) {
        const user = ctx.state && ctx.state.user;
        return !(user && (await isAppAdmin(user.id)));
      }
    }
    return false;
  };

  return {
    // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
    // and flat field operators to native v5 params before core handling.
    async find(ctx) {
      adaptCtxQuery(ctx);
      return super.find(ctx);
    },

    async create(ctx) {
      if (await refused(ctx, [requestedType(ctx)])) return ctx.forbidden(FORBIDDEN);
      return super.create(ctx);
    },

    async update(ctx) {
      if (await refused(ctx, [await storedType(ctx), requestedType(ctx)])) return ctx.forbidden(FORBIDDEN);
      return super.update(ctx);
    },

    async delete(ctx) {
      if (await refused(ctx, [await storedType(ctx)])) return ctx.forbidden(FORBIDDEN);
      return super.delete(ctx);
    },
  };
});
