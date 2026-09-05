'use strict';

/**
 * order CUSTOM routes (v5). Ported from v3 api/orders/config/routes.json.
 * These are the 7 non-CRUD endpoints; their handlers are stubbed
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
      path: '/orders/table',
      handler: 'order.table',
    },
    {
      method: 'GET',
      path: '/orders/infoall',
      handler: 'order.infoAll',
    },
    {
      method: 'POST',
      path: '/orders/check-multidelivery/',
      handler: 'order.checkMultidelivery',
    },
    {
      method: 'GET',
      path: '/orders/collection-point-routes',
      handler: 'order.collectionPointRoutes',
    },
    {
      method: 'POST',
      path: '/orders/csv',
      handler: 'order.createCSV',
    },
    {
      method: 'POST',
      path: '/orders/invoice',
      handler: 'order.invoice',
    },
    {
      method: 'POST',
      path: '/orders/pdf/',
      handler: 'order.pdfmultiple',
    },
  ],
};
