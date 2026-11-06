'use strict';

/**
 * bank-rule service (v5), issues/413. Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::bank-rule.bank-rule');
