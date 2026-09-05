'use strict';

/**
 * verifactu-declaration core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-verifactu-declaration.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::verifactu-declaration.verifactu-declaration');
