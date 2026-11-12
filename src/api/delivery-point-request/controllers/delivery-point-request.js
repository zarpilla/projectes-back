'use strict';
/* global strapi */

/**
 * delivery-point-request controller (v5). «Consulta i autorització nou punt
 * d'entrega» (issues/357, Joel, la Diligència): a member asks for a delivery
 * point the service doesn't cover yet. The request is mailed to the office
 * (lifecycles) and kept here as a record: who asked, when, and whether it has
 * been answered; the answer itself goes by e-mail.
 *
 * Who asked and who answered are the server's to say. A member (or a driver)
 * reads only her own requests; the office (orders_admin) and admins read them
 * all and are the only ones who mark them answered (route policy).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { appPermissionsOf } = require('../../../services/app-permissions');

const UID = 'api::delivery-point-request.delivery-point-request';
const REQUIRED = { city: 'la població', address: "l'adreça", schedule: "l'horari" };
const MEMBER_FIELDS = ['trade_name', 'city', 'address', 'schedule', 'estimated_weight', 'notes'];

const payloadOf = (ctx) => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/** Whether the user reads every request: the office and the full-access users. */
async function seesAll(userId) {
  const permissions = await appPermissionsOf(userId);
  return ['admin', 'orders_admin', 'projects'].some((p) => permissions.includes(p));
}

/** What a new request lacks, or null. */
function missingFields(payload) {
  const missing = Object.keys(REQUIRED).filter((key) => blank(payload[key]));
  if (!missing.length) return null;
  const names = missing.map((key) => REQUIRED[key]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}` : names[0];
  return `Falta ${list}.`;
}

module.exports = createCoreController(UID, () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    const user = ctx.state.user;
    if (user && !(await seesAll(user.id))) {
      const filters = ctx.query.filters || {};
      ctx.query = { ...ctx.query, filters: { $and: [filters, { user: { id: user.id } }] } };
    }
    return super.find(ctx);
  },

  async findOne(ctx) {
    const user = ctx.state.user;
    if (user && !(await seesAll(user.id))) {
      const where = /^\d+$/.test(String(ctx.params.id)) ? { id: Number(ctx.params.id) } : { documentId: ctx.params.id };
      const row = await strapi.db.query(UID).findOne({ where, populate: { user: { select: ['id'] } } });
      if (!row || !row.user || row.user.id !== user.id) return ctx.notFound();
    }
    return super.findOne(ctx);
  },

  async create(ctx) {
    const payload = payloadOf(ctx);
    for (const key of Object.keys(payload)) if (!MEMBER_FIELDS.includes(key)) delete payload[key];
    const missing = missingFields(payload);
    if (missing) return ctx.badRequest(missing);
    payload.user = ctx.state.user ? ctx.state.user.id : null;
    payload.answered = false;
    if (!ctx.request.body.data) ctx.request.body = { data: payload };
    return super.create(ctx);
  },

  /** The office marks a request answered (or not); the rest stays as sent. */
  async update(ctx) {
    const payload = payloadOf(ctx);
    const answered = payload.answered === true || payload.answered === 'true';
    for (const key of Object.keys(payload)) delete payload[key];
    payload.answered = answered;
    payload.answered_date = answered ? new Date() : null;
    payload.answered_user = answered && ctx.state.user ? ctx.state.user.id : null;
    if (!ctx.request.body.data) ctx.request.body = { data: payload };
    return super.update(ctx);
  },
}));

module.exports.missingFields = missingFields;
