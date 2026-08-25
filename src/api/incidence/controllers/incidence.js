'use strict';
/* global strapi */

/**
 * incidence controller (v5). Ported from v3 api/incidences/controllers/incidences.js.
 * Custom endpoint: infoAll; update override passes the user id for lifecycle tracking.
 */
const moment = require('moment');
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::incidence.incidence', ({ strapi }) => ({
  /**
   * PUT /api/incidences/:id — adds current user id for lifecycle tracking.
   */
  async update(ctx) {
    const { id } = ctx.params;
    if (ctx.state.user) {
      ctx.params.id_user = ctx.state.user.id;
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

    const limit = query._limit || -1;
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
      limit: limit === -1 ? -1 : parseInt(limit),
      orderBy: sort.includes(':')
        ? { [sort.split(':')[0]]: sort.split(':')[1].toLowerCase() }
        : { id: 'desc' },
    });

    return incidences.map((incidence) => {
      const createdAt = incidence.created_at ? moment(incidence.created_at) : null;
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
