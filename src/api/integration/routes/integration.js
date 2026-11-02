'use strict';

/**
 * Integrations API: a member's own system writes her delivery points and
 * orders, authenticated by an API key in the `x-api-key` header
 * (policies/api-key.js), not by a user's JWT. Documented in
 * docs/INTEGRATIONS_API.md.
 *
 * The API keys themselves are managed by the app admins from Administració ›
 * Usuàries (JWT + isAdmin).
 */
const KEY = { auth: false, policies: ['global::api-key'] };
const ADMIN = { policies: ['global::isAdmin'] };

module.exports = {
  routes: [
    { method: 'PUT', path: '/integrations/contacts', handler: 'integration.syncContacts', config: KEY },
    { method: 'PUT', path: '/integrations/orders', handler: 'integration.syncOrders', config: KEY },
    { method: 'POST', path: '/integrations/orders/cancel', handler: 'integration.cancelOrders', config: KEY },
    { method: 'GET', path: '/integrations/orders', handler: 'integration.orders', config: KEY },
    { method: 'GET', path: '/integrations/catalog', handler: 'integration.catalog', config: KEY },

    { method: 'GET', path: '/integrations/api-keys', handler: 'integration.listApiKeys', config: ADMIN },
    { method: 'POST', path: '/integrations/api-keys', handler: 'integration.createApiKey', config: ADMIN },
    {
      method: 'DELETE',
      path: '/integrations/api-keys/:id',
      handler: 'integration.revokeApiKey',
      config: ADMIN,
    },
  ],
};
