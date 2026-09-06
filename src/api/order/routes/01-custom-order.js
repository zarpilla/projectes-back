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
 *
 * Paths carry NO trailing slash. v3's routes.json wrote two of them with one
 * ("/orders/check-multidelivery/", "/orders/pdf/") and Strapi 3's router
 * matched anyway; v5's does not. The callers post without the slash, so the
 * request instead fell through to the core `/orders/:documentId` route, which
 * has no POST — hence 405 Method Not Allowed rather than a 404.
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
      path: '/orders/check-multidelivery',
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
      path: '/orders/pdf',
      handler: 'order.pdfmultiple',
    },
  ],
};
