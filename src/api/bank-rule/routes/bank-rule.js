'use strict';

/**
 * bank-rule core router (v5), issues/413.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::bank-rule.bank-rule');
