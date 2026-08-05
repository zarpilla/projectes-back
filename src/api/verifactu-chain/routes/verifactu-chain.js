'use strict';

/**
 * verifactu-chain core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/custom-verifactu-chain.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::verifactu-chain.verifactu-chain');
