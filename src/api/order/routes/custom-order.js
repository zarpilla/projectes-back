'use strict';

/**
 * order CUSTOM routes (v5). Ported from v3 api/orders/config/routes.json.
 * These are the 7 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/orders automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/table',
      handler: 'order.table',
    },
    {
      method: 'GET',
      path: '/infoall',
      handler: 'order.infoAll',
    },
    {
      method: 'POST',
      path: '/check-multidelivery/',
      handler: 'order.checkMultidelivery',
    },
    {
      method: 'GET',
      path: '/collection-point-routes',
      handler: 'order.collectionPointRoutes',
    },
    {
      method: 'POST',
      path: '/csv',
      handler: 'order.createCSV',
    },
    {
      method: 'POST',
      path: '/invoice',
      handler: 'order.invoice',
    },
    {
      method: 'POST',
      path: '/pdf/',
      handler: 'order.pdfmultiple',
    },
  ],
};
