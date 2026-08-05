'use strict';

/**
 * emitted-invoice CUSTOM routes (v5). Ported from v3 api/emitted-invoice/config/routes.json.
 * These are the 6 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/emitted-invoices automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'emitted-invoice.findBasic',
    },
    {
      method: 'POST',
      path: '/pay-vat',
      handler: 'emitted-invoice.payVat',
    },
    {
      method: 'POST',
      path: '/pay-vat-ids',
      handler: 'emitted-invoice.payVatIds',
    },
    {
      method: 'POST',
      path: '/send-email/:id',
      handler: 'emitted-invoice.sendInvoiceByEmail',
    },
    {
      method: 'GET',
      path: '/pending-provider',
      handler: 'emitted-invoice.pendingProvider',
    },
    {
      method: 'GET',
      path: '/pdf/:doc/:id',
      handler: 'emitted-invoice.pdf',
    },
  ],
};
