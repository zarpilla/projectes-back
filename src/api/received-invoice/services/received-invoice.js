'use strict';

/**
 * received-invoice service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::received-invoice.received-invoice', ({ strapi }) => ({
  // Default core service methods are inherited.
  // Add custom service logic here as it is ported in Phase 4.
}));
