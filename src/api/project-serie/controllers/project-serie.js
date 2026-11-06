'use strict';

/**
 * project-serie controller: the series that number the projects
 * («[2026-001] Nom», services/project-series.js). Core CRUD, v3 query params.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::project-serie.project-serie', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
