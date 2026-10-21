'use strict';

/**
 * project service (v5). Core service methods (find/findOne/create/update/delete)
 * provided by createCoreService — required by the core API controllers.
 *
 * The daily dedications and festives the project engine reads come from
 * src/services/calendars.js (through the read cache, issues/307).
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::project.project');
