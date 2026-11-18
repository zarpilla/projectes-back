'use strict';

/**
 * delivery-point-request core router (v5). «Consulta i autorització nou punt
 * d'entrega» (issues/357): every logistics user sends a request and reads her
 * own; the office reads them all and marks them answered.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::delivery-point-request.delivery-point-request', {
  config: {
    update: { policies: ['global::isAdminOrOffice'] },
    delete: { policies: ['global::isAdminOrOffice'] },
  },
});
