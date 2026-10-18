'use strict';

/**
 * logo core router (v5). Edited from the app's administration: writes are for
 * admins, like the other auxiliary tables (issues/159).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::logo.logo', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
