'use strict';

const moment = require('moment');

/**
 * Concept of the invoice line of an order: «Comanda 03/09/2026 | 23172 |
 * DJ - BCN CIUTAT». The date was written as stored (2026-09-03), unlike the
 * rest of the invoice (issues/111).
 */
function orderLineConcept(order) {
  const day = moment(order.estimated_delivery_date, 'YYYY-MM-DD', true);
  const date = day.isValid() ? day.format('DD/MM/YYYY') : order.estimated_delivery_date || '';
  const route = order.route && order.route.name;
  return [date ? `Comanda ${date}` : 'Comanda', String(order.id).padStart(4, '0'), route].filter(Boolean).join(' | ');
}

module.exports = { orderLineConcept };
