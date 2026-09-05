'use strict';

/**
 * logo core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-logo.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::logo.logo');
