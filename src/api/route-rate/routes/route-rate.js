'use strict';

/**
 * route-rate core router (v5). Edited from «Taules auxiliars»: writes are for admins,
 * like the other auxiliary tables (issues/139, issues/140).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::route-rate.route-rate', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
