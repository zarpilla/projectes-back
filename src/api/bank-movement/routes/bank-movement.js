'use strict';

/**
 * bank-movement core router (v5), read only: movements come from the imported
 * statements and change through the «Conciliació» actions (issues/413).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::bank-movement.bank-movement', { only: ['find', 'findOne'] });
