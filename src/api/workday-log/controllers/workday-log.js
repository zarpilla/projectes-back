'use strict';

/**
 * workday-log controller (v5). Core CRUD is provided by createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

/**
 * The "Registre Jornades" grid resolves each row's project through
 * `log.activity.project`. v3 stored relations as FK columns, so the nested
 * activity carried its `project` id for free; v5 stops at the first level, so
 * the field was absent and every saved row came back with no project attached.
 */
const WORKDAY_GRAPH = {
  users_permissions_user: true,
  activity: { populate: { project: true } },
};

module.exports = createCoreController('api::workday-log.workday-log', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    // '*' is the v3-compat middleware's default; only an explicit caller populate wins.
    if (!ctx.query.populate || ctx.query.populate === '*') {
      ctx.query = { ...ctx.query, populate: WORKDAY_GRAPH };
    }
    return super.find(ctx);
  },

  // Default core actions (findOne/create/update/delete) are inherited.
}));
