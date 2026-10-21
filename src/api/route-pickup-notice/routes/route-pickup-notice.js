'use strict';

/**
 * route-pickup-notice core router (v5). «Avisos de dipòsit» (issues/313): edited
 * from Taules auxiliars › Logística by admins and the logistics office, like the
 * route rates; read by the order form.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::route-pickup-notice.route-pickup-notice', {
  config: {
    create: { policies: ['global::isAdminOrOffice'] },
    update: { policies: ['global::isAdminOrOffice'] },
    delete: { policies: ['global::isAdminOrOffice'] },
  },
});
