'use strict';

/**
 * vat-return controller (v5). No routes of its own: IVA › Models 303 i 390
 * files and reads them through the treasury endpoints (treasuries/vat-models/*),
 * which build the snapshot on the server.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::vat-return.vat-return');
