'use strict';

/**
 * project service (v5). Core service methods (find/findOne/create/update/delete)
 * provided by createCoreService — required by the core API controllers.
 *
 * The dedication/festive cache helpers this file used to hold live in
 * ./projectCache.js (they are a plain shared module, not service methods).
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::project.project');
