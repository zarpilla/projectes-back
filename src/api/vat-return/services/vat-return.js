'use strict';

/**
 * vat-return service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::vat-return.vat-return');
