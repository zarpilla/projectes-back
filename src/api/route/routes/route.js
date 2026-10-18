'use strict';

/**
 * route core router (v5). Registers the CRUD routes at /api/routes but `delete`:
 * a route is disabled (`active = false`), never removed, so old orders keep it
 * (issues/141). Who may write is in services/app-access-rules.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::route.route', {
  only: ['find', 'findOne', 'create', 'update'],
});
