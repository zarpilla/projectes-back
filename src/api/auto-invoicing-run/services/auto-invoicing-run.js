'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::auto-invoicing-run.auto-invoicing-run');
