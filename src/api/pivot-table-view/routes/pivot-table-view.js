'use strict';

/**
 * pivot-table-view core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-pivot-table-view.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::pivot-table-view.pivot-table-view');
