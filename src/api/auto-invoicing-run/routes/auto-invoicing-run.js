'use strict';

/**
 * auto-invoicing-run core router (v5): the record of the automatic monthly
 * invoicing runs (issues/430), read by the office in Logística › Facturar.
 * Written only by the server.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::auto-invoicing-run.auto-invoicing-run', {
  only: ['find', 'findOne'],
  config: {
    find: { policies: ['global::isAdminOrOffice'] },
    findOne: { policies: ['global::isAdminOrOffice'] },
  },
});
