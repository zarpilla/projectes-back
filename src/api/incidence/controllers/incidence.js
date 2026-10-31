'use strict';
/* global strapi */

/**
 * incidence controller (v5). Ported from v3 api/incidences/controllers/incidences.js.
 * Custom endpoint: infoAll; update override passes the user id for lifecycle tracking.
 */
const moment = require('moment');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { statsDateRange } = require('../../../services/stats-date-range');
const { setCurrentUserId } = require('../utils/updater');
const { numericId } = require('../../../middlewares/v3-compat');

// What the v3 default `populate=*` gives, plus the author of every reply: `*`
// reaches the incidence_response component but not the user relation inside
// it, so the replies showed «Usuari desconegut» (issues/154).
const USER_FIELDS = { fields: ['id', 'username', 'fullname'] };
const FIND_ONE_POPULATE = {
  created_user: USER_FIELDS,
  closed_user: USER_FIELDS,
  order: true,
  incidence_response: { populate: { user: USER_FIELDS } },
};

const STATE_LABELS = { open: 'Oberta', wip: 'En procés', closed: 'Tancada' };

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);

const incidenceWhere = (incidenceId) =>
  /^\d+$/.test(String(incidenceId)) ? { id: Number(incidenceId) } : { documentId: incidenceId };

/**
 * Reopening a closed incidence clears when and by whom it was closed
 * (issues/226). The screen sends only the new state; for users without full
 * access app-permissions already did it (issues/190), for the others the
 * panel still said «Tancada …» after reopening.
 */
async function clearClosedOnReopen(incidenceId, payload) {
  const { state } = payload;
  if (state === undefined || state === null || state === 'closed') return;
  const stored = await strapi.db
    .query('api::incidence.incidence')
    .findOne({ where: incidenceWhere(incidenceId), select: ['id', 'state'] });
  if (stored && stored.state === 'closed') {
    payload.closed_date = null;
    payload.closed_user = null;
  }
}

/**
 * The replies an update leaves: the stored ones as they are, plus the ones
 * sent after them, in the name of whoever sends them and dated now
 * (issues/164). The screen sends the replies it has with the new one at the
 * end; the replies used to be replaced by whatever was sent, author included,
 * so a member could rewrite the office's answers or sign a reply as someone
 * else.
 */
async function appendedReplies(incidenceId, sent, user) {
  const stored = await strapi.db
    .query('api::incidence.incidence')
    .findOne({ where: incidenceWhere(incidenceId), populate: { incidence_response: { populate: { user: true } } } });
  const kept = ((stored && stored.incidence_response) || []).map((reply) => ({
    id: reply.id,
    text: reply.text,
    user: idOf(reply.user) || null,
    response_date: reply.response_date,
  }));
  const added = sent
    .slice(kept.length)
    .filter((reply) => reply && typeof reply.text === 'string' && reply.text.trim())
    .map((reply) => ({ text: reply.text, user: user ? user.id : null, response_date: new Date() }));
  return [...kept, ...added];
}

module.exports = createCoreController('api::incidence.incidence', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/incidences/:id — with the author of each reply (issues/154). A
   * populate the caller asked for is kept.
   */
  async findOne(ctx) {
    if (ctx.state && ctx.state.v3DefaultPopulate) {
      ctx.query = { ...ctx.query, populate: FIND_ONE_POPULATE };
    }
    return super.findOne(ctx);
  },

  /**
   * PUT /api/incidences/:id — passes the current user id to the lifecycle
   * (used to decide notification recipients) via the module-level setter,
   * since v5 lifecycles don't receive ctx.
   */
  async update(ctx) {
    const body = ctx.request.body || {};
    const payload = body.data && typeof body.data === 'object' ? body.data : body;
    if (Array.isArray(payload.incidence_response)) {
      payload.incidence_response = await appendedReplies(
        numericId(ctx),
        payload.incidence_response,
        ctx.state.user,
      );
    }
    await clearClosedOnReopen(numericId(ctx), payload);
    if (ctx.state.user) {
      setCurrentUserId(ctx.state.user.id);
    }
    // Delegate to the core update with the enriched params.
    return super.update(ctx);
  },

  /**
   * GET /api/incidences/infoall
   * Aggregated incidence info filtered by year/month.
   */
  async infoAll(ctx) {
    const { year, month, ...query } = ctx.query;

    const range = statsDateRange(year, month);
    if (range) {
      query['created_at_gte'] = range.from;
      // `createdAt` is a date and time: `<= 2026-10-31` stopped at midnight and
      // left out every incidence of the period's last day. Before the next day.
      query['created_at_lt'] = moment(range.to).add(1, 'day').format('YYYY-MM-DD');
    }

    // v3 sent _limit=-1 for 'all rows'; db.query says that by omitting the limit.
    const limit =
      query._limit && Number(query._limit) >= 0 ? parseInt(query._limit, 10) : undefined;
    const sort = query._sort || 'id:DESC';
    delete query._limit;
    delete query._sort;

    // Build where from the v3 flat operators
    const { adaptQuery } = require('../../../services/query-adapter');
    const opts = adaptQuery(query);

    const incidences = await strapi.db.query('api::incidence.incidence').findMany({
      where: opts.filters || {},
      populate: {
        created_user: true,
        closed_user: true,
        order: { populate: { owner: true, route: true } },
      },
      limit,
      orderBy: sort.includes(':')
        ? { [sort.split(':')[0]]: sort.split(':')[1].toLowerCase() }
        : { id: 'desc' },
    });

    const rows = incidences.map((incidence) => {
      const createdAt = incidence.createdAt ? moment(incidence.createdAt) : null;
      return {
        id: incidence.id,
        count: 1,
        // the ids, as v3 gave them (the populated relation printed «[object Object]» in the Excel export)
        owner: incidence.order?.owner ? `${incidence.order.owner.id}` : 'Sense sòcia',
        owner_name: incidence.order?.owner?.fullname || incidence.order?.owner?.username || 'Sense sòcia',
        created_user: incidence.created_user?.fullname || incidence.created_user?.username || 'Desconegut',
        created_user_id: incidence.created_user?.id || null,
        route: incidence.order?.route ? `${incidence.order.route.id}` : 'Sense ruta',
        route_name: incidence.order?.route?.short_name || incidence.order?.route?.name || 'Sense ruta',
        // «En procés» was labelled «Tancada» (issues/154)
        state: STATE_LABELS[incidence.state] || 'Oberta',
        state_raw: incidence.state,
        created_at: createdAt ? createdAt.format('YYYY-MM-DD') : null,
        closed_date: incidence.closed_date ? moment(incidence.closed_date).format('YYYY-MM-DD') : null,
        closed_user: incidence.closed_user?.fullname || incidence.closed_user?.username || null,
        description: incidence.description,
        order_id: incidence.order?.id || null,
        year: createdAt ? `${createdAt.year()}` : null,
        month: createdAt ? `${createdAt.month() + 1}` : null,
      };
    });
    // without a year there is no date range: keep that month of every year
    return month && !isNaN(month) ? rows.filter((r) => Number(r.month) === Number(month)) : rows;
  },
}));
