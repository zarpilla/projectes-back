'use strict';

/**
 * emitted-invoice core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-emitted-invoice.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::emitted-invoice.emitted-invoice');
