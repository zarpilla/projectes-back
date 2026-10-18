'use strict';

/**
 * verifactu controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');

module.exports = createCoreController('api::verifactu.verifactu', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    const response = await super.find(ctx);
    // the keystore's media (its URL) stays out of the API: the app reads what
    // it needs from /api/certificates/verifactu (issues/159)
    const data = response && response.data;
    if (data && typeof data === 'object') delete (data.attributes || data).certificate;
    return response;
  },

  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
