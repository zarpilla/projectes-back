'use strict';

/**
 * incidence-category core router (v5). «Categories d'incidència» (issues/431):
 * edited by admins only from Taules auxiliars › Logística; read by everyone who
 * opens an incidence (the incidence modal, Incidències).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::incidence-category.incidence-category', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
