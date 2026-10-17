'use strict';

/**
 * task-template controller (v5). A template is a named list of tasks (items: name,
 * description, Funció, priority, estimated hours, days from the start, checklist)
 * saved from a project's tasks and applied to another project.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::task-template.task-template', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },
}));
