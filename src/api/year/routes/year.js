'use strict';

/**
 * year core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-year.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::year.year', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
