'use strict';
/* global strapi */

/**
 * incidence controller (v5). Ported from v3 api/incidences/controllers/incidences.js.
 * Custom endpoint: infoAll; update override passes the user id for lifecycle tracking.
 */
const moment = require('moment');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { setCurrentUserId } = require('../utils/updater');

module.exports = createCoreController('api::incidence.incidence', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * PUT /api/incidences/:id — passes the current user id to the lifecycle
   * (used to decide notification recipients) via the module-level setter,
   * since v5 lifecycles don't receive ctx.
   */
  async update(ctx) {
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

    if (year && !isNaN(year)) {
      query['created_at_gte'] = `${year}-01-01`;
      query['created_at_lte'] = `${year}-12-31`;
    }
    if (month && !isNaN(month)) {
      query['created_at_gte'] = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = moment(`${year}-${month}`, 'YYYY-MM').daysInMonth();
      query['created_at_lte'] =
        `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
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

    return incidences.map((incidence) => {
      const createdAt = incidence.createdAt ? moment(incidence.createdAt) : null;
      return {
        id: incidence.id,
        count: 1,
        owner: incidence.order?.owner ? `${incidence.order.owner}` : 'Sense sòcia',
        owner_name: incidence.order?.owner?.fullname || incidence.order?.owner?.username || 'Sense sòcia',
        created_user: incidence.created_user?.fullname || incidence.created_user?.username || 'Desconegut',
        created_user_id: incidence.created_user?.id || null,
        route: incidence.order?.route ? `${incidence.order.route}` : 'Sense ruta',
        route_name: incidence.order?.route?.short_name || incidence.order?.route?.name || 'Sense ruta',
        state: incidence.state === 'open' ? 'Oberta' : 'Tancada',
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
  },
}));
