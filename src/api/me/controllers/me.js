'use strict';

/**
 * me controller (v5). Ported from v3 api/me/controllers/me.js.
 * The `me` content type is a single-type holding instance-wide settings.
 *
 * DIR3 proxy endpoints forward to an external DIR3 registry API using the URL
 * and token stored on the `me` record. The v3 axios logic is preserved verbatim;
 * only the data-access changes to Document Service.
 */
const { decryptSecret } = require('../../../services/secret-crypto');
const axios = require('axios');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { getMe, tokenFlags } = require('../../../services/me-settings');
const { isAppAdmin } = require('../../../services/app-permissions');
const { ticketsConfig, buildTicketsLoginUrl } = require('../../../services/tickets-sso');
const { docsConfig, buildDocsLoginUrl } = require('../../../services/docs-sso');
const { ssoTenant } = require('../../../services/sso-tenant');
const { checkBaseUrl, outboundAxiosOptions, upstreamError } = require('../../../services/outbound-url');

module.exports = createCoreController('api::me.me', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    const response = await super.find(ctx);
    // only Configuració general (admins) needs to know which tokens are set
    const data = response && response.data;
    // key material stays out of the API, for admins too: certificates are
    // managed through /api/certificates, read from disk only (issues/159)
    if (data && typeof data === 'object') {
      for (const field of ['face_certificate', 'google_credentials']) delete (data.attributes || data)[field];
    }
    if (data && typeof data === 'object' && ctx.state?.user && (await isAppAdmin(ctx.state.user.id))) {
      Object.assign(data.attributes || data, await tokenFlags());
    }
    return response;
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

      // an admin-configured URL: https and public addresses only (issues/378)
      const baseUrl = checkBaseUrl(meSettings.dir3_api_url);
      const response = await axios.get(`${baseUrl}/api/search/nif/${encodeURIComponent(nif)}`, {
        headers: { 'X-API-Key': decryptSecret(meSettings.dir3_api_token) },
        ...outboundAxiosOptions(),
      });
      return response.data;
    } catch (error) {
      return upstreamError(ctx, error, 'DIR3 search by NIF', 'Error connecting to DIR3 API');
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

      const baseUrl = checkBaseUrl(meSettings.dir3_api_url);
      let url = `${baseUrl}/api/search/name/${encodeURIComponent(name)}`;
      if (limit) {
        url += `?limit=${encodeURIComponent(String(limit))}`;
      }

      const response = await axios.get(url, {
        headers: { 'X-API-Key': decryptSecret(meSettings.dir3_api_token) },
        ...outboundAxiosOptions(),
      });
      return response.data;
    } catch (error) {
      return upstreamError(ctx, error, 'DIR3 search by name', 'Error connecting to DIR3 API');
    }
  },

  /**
   * Login link to the tickets site for the current user (issues/019).
   * The front opens the returned URL in a new tab.
   */
  async ticketsLogin(ctx) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized();
    }
    const me = await getMe([]);
    const config = ticketsConfig(process.env, me && me.name, await ssoTenant(strapi, (me && me.name) || ''));
    if (!config) {
      return ctx.badRequest('Tickets are not configured on this instance');
    }
    if (!user.email) {
      return ctx.badRequest('Your user has no email address');
    }
    const url = buildTicketsLoginUrl({ ...config, email: user.email, name: user.username || user.email });
    ctx.set('Cache-Control', 'no-store');
    return { url };
  },

  /**
   * Login link to the documentation site for the current user, with her app
   * permissions (they pick the chapters she reads) and, from ?route=, the screen
   * she is on. The front opens the returned URL in a new tab.
   */
  async docsLogin(ctx) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized();
    }
    const me = await getMe([]);
    const config = docsConfig(process.env, me && me.name, await ssoTenant(strapi, (me && me.name) || ''));
    if (!config) {
      return ctx.badRequest('Documentation is not configured on this instance');
    }
    const full = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { id: user.id }, populate: { permissions: true } });
    const roles = ((full && full.permissions) || []).map((p) => p && p.permission).filter(Boolean);
    const url = buildDocsLoginUrl({
      ...config,
      email: user.email || '',
      name: user.username || user.email || '',
      roles,
      route: ctx.query && ctx.query.route,
    });
    ctx.set('Cache-Control', 'no-store');
    return { url };
  },
}));
