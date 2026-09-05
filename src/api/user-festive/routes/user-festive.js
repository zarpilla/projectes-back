'use strict';

/**
 * user-festive core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-user-festive.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::user-festive.user-festive', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
