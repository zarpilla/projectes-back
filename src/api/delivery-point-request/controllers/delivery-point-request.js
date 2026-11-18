'use strict';
/* global strapi */

/**
 * delivery-point-request controller (v5). «Consulta i autorització nou punt
 * d'entrega» (issues/357, Joel, la Diligència): a member asks for a delivery
 * point the service doesn't cover yet. The request is mailed to the office
 * (lifecycles) and kept here as a record: who asked, when, and the office's
 * decision, approved or rejected, with an optional message mailed to the
 * member (issues/357, seguiment). `answered` means decided; a request answered before
 * issues/357, seguiment has no `status` and stays «Resposta». The office archives the
 * decided ones so the list doesn't carry the whole history, and links the
 * delivery point it creates from an approved one (`contact`).
 *
 * Who asked and who decided are the server's to say. A member (or a driver)
 * reads only her own requests; the office (orders_admin) and admins read them
 * all and are the only ones who decide, archive and link (route policy).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { appPermissionsOf } = require('../../../services/app-permissions');

const UID = 'api::delivery-point-request.delivery-point-request';
const STATUSES = ['approved', 'rejected'];
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

const truthy = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * The office's changes, from what it sends: only the keys present are applied.
 * `status` approved / rejected decides the request (who and when), null takes
 * it back to pending; `answer` is the message to the member; `archived` hides
 * it from the list; `contact` is the delivery point created from it.
 */
function officeChanges(payload, userId) {
  const changes = {};
  if ('status' in payload) {
    const status = STATUSES.includes(payload.status) ? payload.status : null;
    changes.status = status;
    changes.answered = !!status;
    changes.answered_date = status ? new Date() : null;
    changes.answered_user = status && userId ? userId : null;
  }
  if ('answer' in payload) changes.answer = blank(payload.answer) ? null : String(payload.answer).trim();
  if ('archived' in payload) changes.archived = truthy(payload.archived);
  if ('contact' in payload) {
    const id = Number(payload.contact && typeof payload.contact === 'object' ? payload.contact.id : payload.contact);
    changes.contact = Number.isInteger(id) && id > 0 ? id : null;
  }
  return changes;
}

/**
 * Archived requests are listed apart (`_archived=1`); a request saved before
 * the column existed (null) counts as not archived.
 */
function archiveFilter(archived) {
  return archived ? { archived: { $eq: true } } : { $or: [{ archived: { $eq: false } }, { archived: { $null: true } }] };
}

module.exports = createCoreController(UID, () => ({
  async find(ctx) {
    const archivedParam = ctx.query && ctx.query._archived;
    if (ctx.query) delete ctx.query._archived;
    adaptCtxQuery(ctx);
    const user = ctx.state.user;
    const and = [ctx.query.filters || {}];
    if (user && !(await seesAll(user.id))) and.push({ user: { id: user.id } });
    // the office's list hides the archived ones; a member sees all hers
    else if (archivedParam !== undefined) and.push(archiveFilter(truthy(archivedParam)));
    if (and.length > 1) ctx.query = { ...ctx.query, filters: { $and: and } };
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

  /**
   * The office approves or rejects a request, archives it or links the point
   * created from it; what the member sent stays as sent. A new decision is
   * mailed to the member, after it is saved.
   */
  async update(ctx) {
    const payload = payloadOf(ctx);
    const userId = ctx.state.user ? ctx.state.user.id : null;
    const changes = officeChanges(payload, userId);
    for (const key of Object.keys(payload)) delete payload[key];
    Object.assign(payload, changes);
    if (!ctx.request.body.data) ctx.request.body = { data: payload };
    const where = /^\d+$/.test(String(ctx.params.id)) ? { id: Number(ctx.params.id) } : { documentId: ctx.params.id };
    const before = 'status' in changes ? await strapi.db.query(UID).findOne({ where }) : null;
    const res = await super.update(ctx);
    if (before && changes.status && changes.status !== before.status) {
      try {
        await strapi.service(UID).sendDecisionEmail(before.id);
      } catch (error) {
        strapi.log.error(`[delivery-point-request] the decision mail of request ${before.id} failed: ${error.message}`);
      }
    }
    return res;
  },
}));

module.exports.missingFields = missingFields;
module.exports.officeChanges = officeChanges;
module.exports.archiveFilter = archiveFilter;
