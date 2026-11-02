'use strict';
/* global strapi */

/**
 * route-festive lifecycles: a closure's substitute route needs its date
 * (services/route-closure.js, issues/355). NOTE: v5 lifecycle modules may only
 * export hook functions.
 */
const { checkClosure } = require('../../../../services/route-closure');

module.exports = {
  beforeCreate(event) {
    checkClosure(event.params.data);
  },
  async beforeUpdate(event) {
    const where = event.params && event.params.where;
    const stored = where
      ? await strapi.db
          .query('api::route-festive.route-festive')
          .findOne({ where, populate: { route: true, substitute_route: true } })
      : null;
    checkClosure(event.params.data, stored);
  },
};
