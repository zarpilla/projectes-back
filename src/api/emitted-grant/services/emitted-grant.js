'use strict';

/**
 * emitted-grant service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::emitted-grant.emitted-grant', ({ strapi }) => ({
  // Default core service methods are inherited.
  // Add custom service logic here as it is ported in Phase 4.
}));
