'use strict';

/**
 * income-type core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-income-type.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::income-type.income-type', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
