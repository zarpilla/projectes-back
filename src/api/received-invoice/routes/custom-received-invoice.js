'use strict';

/**
 * received-invoice CUSTOM routes (v5). Ported from v3 api/received-invoice/config/routes.json.
 * These are the 2 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/received-invoices automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'received-invoice.findBasic',
    },
    {
      method: 'POST',
      path: '/upload',
      handler: 'received-invoice.upload',
    },
  ],
};
