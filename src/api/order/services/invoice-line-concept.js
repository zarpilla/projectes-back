'use strict';

const moment = require('moment');

/**
 * Concept of the invoice line of an order: «Comanda 03/09/2026 | 23172 |
 * DJ - BCN CIUTAT». The date was written as stored (2026-09-03), unlike the
 * rest of the invoice (issues/111). A collection order's number carries «-R»,
 * as everywhere else (issues/298).
 */
function orderLineConcept(order) {
  const day = moment(order.estimated_delivery_date, 'YYYY-MM-DD', true);
  const date = day.isValid() ? day.format('DD/MM/YYYY') : order.estimated_delivery_date || '';
  const route = order.route && order.route.name;
  const number = `${String(order.id).padStart(4, '0')}${order.is_collection_order ? '-R' : ''}`;
  return [date ? `Comanda ${date}` : 'Comanda', number, route].filter(Boolean).join(' | ');
}

/**
 * Concept of a logistics invoice: «Serveis logístics octubre 2026». The month
 * is the orders' estimated delivery month, the one «Facturar» groups them by;
 * it was the first order's route date, which can fall in the month before
 * (issues/155). Orders spanning months read «setembre - octubre 2026».
 */
function invoiceConcept(orders) {
  const months = (orders || [])
    .map((o) => moment(o.estimated_delivery_date || o.route_date, 'YYYY-MM-DD'))
    .filter((m) => m.isValid())
    .sort((a, b) => a.valueOf() - b.valueOf());
  const first = months.length ? months[0] : moment();
  const last = months.length ? months[months.length - 1] : first;
  const name = (m, withYear = true) => m.locale('ca').format(withYear ? 'MMMM YYYY' : 'MMMM');
  if (first.isSame(last, 'month')) return `Serveis logístics ${name(first)}`;
  const from = name(first, !first.isSame(last, 'year'));
  return `Serveis logístics ${from} - ${name(last)}`;
}

module.exports = { orderLineConcept, invoiceConcept };
