'use strict';

/**
 * me controller (v5). Ported from v3 api/me/controllers/me.js.
 * The `me` content type is a single-type holding instance-wide settings.
 *
 * DIR3 proxy endpoints forward to an external DIR3 registry API using the URL
 * and token stored on the `me` record. The v3 axios logic is preserved verbatim;
 * only the data-access changes to Document Service.
 */
const axios = require('axios');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { getMe } = require('../../../services/me-settings');

module.exports = createCoreController('api::me.me', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * Proxy to the DIR3 registry search-by-NIF endpoint.
   */
  async dir3SearchNif(ctx) {
    try {
      const { nif } = ctx.params;
      if (!nif) {
        return ctx.badRequest('NIF parameter is required');
      }

      const meSettings = await getMe();
      if (!meSettings || !meSettings.dir3_api_url || !meSettings.dir3_api_token) {
        return ctx.badRequest('DIR3 API is not configured');
      }

      const response = await axios.get(
        `${meSettings.dir3_api_url}/api/search/nif/${encodeURIComponent(nif)}`,
        { headers: { 'X-API-Key': meSettings.dir3_api_token } },
      );
      return response.data;
    } catch (error) {
      console.error('Error in DIR3 search by NIF:', error);
      if (error.response) {
        return ctx.send(error.response.data, error.response.status);
      }
      return ctx.internalServerError('Error connecting to DIR3 API');
    }
  },

  /**
   * Proxy to the DIR3 registry search-by-name endpoint.
   */
  async dir3SearchName(ctx) {
    try {
      const { name } = ctx.params;
      const { limit } = ctx.query;
      if (!name) {
        return ctx.badRequest('Name parameter is required');
      }

      const meSettings = await getMe();
      if (!meSettings || !meSettings.dir3_api_url || !meSettings.dir3_api_token) {
        return ctx.badRequest('DIR3 API is not configured');
      }

      let url = `${meSettings.dir3_api_url}/api/search/name/${encodeURIComponent(name)}`;
      if (limit) {
        url += `?limit=${limit}`;
      }

      const response = await axios.get(url, {
        headers: { 'X-API-Key': meSettings.dir3_api_token },
      });
      return response.data;
    } catch (error) {
      console.error('Error in DIR3 search by name:', error);
      if (error.response) {
        return ctx.send(error.response.data, error.response.status);
      }
      return ctx.internalServerError('Error connecting to DIR3 API');
    }
  },
}));
