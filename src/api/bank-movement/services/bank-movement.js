'use strict';

/**
 * bank-movement service (v5), issues/413. Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::bank-movement.bank-movement');
