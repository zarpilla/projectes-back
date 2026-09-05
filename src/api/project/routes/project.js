'use strict';

/**
 * project core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-project.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::project.project');
