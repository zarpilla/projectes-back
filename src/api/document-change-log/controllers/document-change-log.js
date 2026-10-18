'use strict';

/**
 * document-change-log controller (v5). Core find/findOne only (see routes),
 * plus one record's history for the forms (issues/161).
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const changeLog = require('../../../services/change-log');

const EMITTED = 'api::emitted-invoice.emitted-invoice';
const MAX_LIMIT = 200;

function pageParam(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return max ? Math.min(n, max) : n;
}

module.exports = createCoreController('api::document-change-log.document-change-log', ({ strapi }) => ({
  // v3 query-param compatibility: the views query with _where/_sort/_limit.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/document-change-logs/history/:entity/:id?start=&limit=
   * `entity`: emitted-invoice, received-invoice, received-income,
   * received-expense, quote or order. Answers for a deleted record too.
   * An emitted invoice also lists the invoices that rectify it.
   */
  async history(ctx) {
    const uid = changeLog.uidOf(ctx.params.entity);
    if (!uid) return ctx.badRequest('Unknown entity');
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.badRequest('Invalid id');
    const query = ctx.query || {};
    const start = pageParam(query.start, 0);
    const limit = pageParam(query.limit, 50, MAX_LIMIT) || 50;

    const page = await changeLog.historyPage(uid, id, { start, limit });
    if (uid === EMITTED) {
      page.rectifiedBy = await strapi.db.query(EMITTED).findMany({
        where: { rectified_invoice: id },
        select: ['id', 'code', 'state', 'emitted', 'createdAt'],
        orderBy: [{ createdAt: 'asc' }],
      });
    }
    return page;
  },
}));
