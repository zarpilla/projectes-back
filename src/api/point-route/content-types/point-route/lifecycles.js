'use strict';
/* global strapi */

/**
 * point-route lifecycles (issues/351): one setting per point and route, at
 * most one main route per point. NOTE: v5 lifecycle modules may only export
 * hook functions.
 */
const { checkPointRoute, clearOtherMains } = require('../../../../services/point-routes');

module.exports = {
  async beforeCreate(event) {
    await checkPointRoute(event.params.data);
  },
  async beforeUpdate(event) {
    const where = event.params && event.params.where;
    const stored = where
      ? await strapi.db
          .query('api::point-route.point-route')
          .findOne({ where, populate: { contact: { select: ['id'] }, route: { select: ['id'] } } })
      : null;
    await checkPointRoute(event.params.data, stored);
  },
  async afterCreate(event) {
    await clearOtherMains(event.result);
  },
  async afterUpdate(event) {
    await clearOtherMains(event.result);
  },
};
