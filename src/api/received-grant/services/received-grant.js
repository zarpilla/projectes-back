'use strict';

/**
 * received-grant service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::received-grant.received-grant', ({ strapi }) => ({
  // Default core service methods are inherited.
  // Add custom service logic here as it is ported in Phase 4.
}));
