'use strict';

/**
 * task-topic core router (v5): everyone reads the topics, admins write them
 * from Taules auxiliars (issues/461).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::task-topic.task-topic', {
  config: {
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
