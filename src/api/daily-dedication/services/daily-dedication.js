'use strict';

/**
 * daily-dedication service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::daily-dedication.daily-dedication', ({ strapi }) => ({
  // Default core service methods are inherited.
  // Add custom service logic here as it is ported in Phase 4.
}));
