'use strict';

/** project-serie core router: everyone with projects reads, the admin writes. */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::project-serie.project-serie', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
