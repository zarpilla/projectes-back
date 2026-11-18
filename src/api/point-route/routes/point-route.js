'use strict';

/**
 * point-route core router (v5). The route settings of a delivery point
 * (issues/351): read by everyone in logistics (the order form offers the
 * point's routes), written by the office only.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::point-route.point-route', {
  config: {
    create: { policies: ['global::isAdminOrOffice'] },
    update: { policies: ['global::isAdminOrOffice'] },
    delete: { policies: ['global::isAdminOrOffice'] },
  },
});
