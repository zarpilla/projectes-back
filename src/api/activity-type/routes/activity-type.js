'use strict';

/**
 * activity-type core router (v5). Renaming and deleting a type (Taules
 * auxiliars) is for admins; creating one stays open, as the project form adds
 * new types inline (issues/159). Custom routes live in 01-custom-activity-type.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::activity-type.activity-type', {
  config: {
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
