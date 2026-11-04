'use strict';

/**
 * treasury CUSTOM routes (v5). Ported from v3 api/treasury/config/routes.json.
 * These are the 1 non-CRUD endpoints; their handlers are stubbed
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
      path: '/treasuries/forecast',
      handler: 'treasury.forecast',
    },
    {
      method: 'GET',
      path: '/treasuries/invoicing-forecast',
      handler: 'treasury.invoicingForecast',
    },
    {
      method: 'GET',
      path: '/treasuries/irpf',
      handler: 'treasury.irpf',
    },
    {
      method: 'GET',
      path: '/treasuries/vat-models',
      handler: 'treasury.vatModels',
    },
    {
      method: 'POST',
      path: '/treasuries/vat-models/classify',
      handler: 'treasury.vatModelsClassify',
    },
    {
      method: 'POST',
      path: '/treasuries/vat-models/returns',
      handler: 'treasury.vatModelsFile',
    },
    {
      method: 'DELETE',
      path: '/treasuries/vat-models/returns/:id',
      handler: 'treasury.vatModelsUnfile',
    },
    {
      method: 'PUT',
      path: '/treasuries/vat-models/returns/:id/receipt',
      handler: 'treasury.vatModelsReceipt',
    },
    {
      method: 'POST',
      path: '/treasuries/vat-models/final-prorrata',
      handler: 'treasury.vatModelsFinalProrrata',
    },
    {
      method: 'GET',
      path: '/treasuries/vat-models/aeat-file',
      handler: 'treasury.vatModelsAeatFile',
    },
    {
      method: 'POST',
      path: '/treasuries/movement-dates',
      handler: 'treasury.updateMovementDates',
    },
  ],
};
