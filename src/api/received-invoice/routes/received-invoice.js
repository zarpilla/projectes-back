'use strict';

/**
 * received-invoice core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-received-invoice.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::received-invoice.received-invoice');
