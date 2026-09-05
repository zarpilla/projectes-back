'use strict';

/**
 * home-menu core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-home-menu.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::home-menu.home-menu');
