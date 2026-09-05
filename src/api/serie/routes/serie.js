'use strict';

/**
 * serie core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-serie.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::serie.serie', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
