'use strict';

/**
 * task-state controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::task-state.task-state', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
