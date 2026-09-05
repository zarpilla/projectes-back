'use strict';

/**
 * emitted-invoice CUSTOM routes (v5). Ported from v3 api/emitted-invoice/config/routes.json.
 * These are the 6 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 mounts custom routes at /api + the path exactly as written — it does NOT
 * namespace them by content type, so each path keeps its v3 plural prefix.
 * The `01-` filename prefix matters: route files load in alphabetical order and
 * the core router's `/<plural>/:id` would otherwise shadow static paths like
 * `/<plural>/basic`.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/emitted-invoices/basic',
      handler: 'emitted-invoice.findBasic',
    },
    {
      method: 'POST',
      path: '/emitted-invoices/pay-vat',
      handler: 'emitted-invoice.payVat',
    },
    {
      method: 'POST',
      path: '/emitted-invoices/pay-vat-ids',
      handler: 'emitted-invoice.payVatIds',
    },
    {
      method: 'POST',
      path: '/emitted-invoices/send-email/:id',
      handler: 'emitted-invoice.sendInvoiceByEmail',
    },
    {
      method: 'GET',
      path: '/emitted-invoices/pending-provider',
      handler: 'emitted-invoice.pendingProvider',
    },
    {
      method: 'GET',
      path: '/emitted-invoices/pdf/:doc/:id',
      handler: 'emitted-invoice.pdf',
    },
  ],
};
