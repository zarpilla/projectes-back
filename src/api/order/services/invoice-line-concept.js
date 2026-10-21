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

/** First and last estimated delivery (or route) date of the orders; today when none. */
function monthRange(orders) {
  const months = (orders || [])
    .map((o) => moment(o.estimated_delivery_date || o.route_date, 'YYYY-MM-DD'))
    .filter((m) => m.isValid())
    .sort((a, b) => a.valueOf() - b.valueOf());
  const first = months.length ? months[0] : moment();
  const last = months.length ? months[months.length - 1] : first;
  return { first, last };
}

/**
 * Concept of a logistics invoice: «Serveis logístics octubre 2026». The month
 * is the orders' estimated delivery month, the one «Facturar» groups them by;
 * it was the first order's route date, which can fall in the month before
 * (issues/155). Orders spanning months read «setembre - octubre 2026».
 */
function invoiceConcept(orders) {
  const { first, last } = monthRange(orders);
  const name = (m, withYear = true) => m.locale('ca').format(withYear ? 'MMMM YYYY' : 'MMMM');
  if (first.isSame(last, 'month')) return `Serveis logístics ${name(first)}`;
  const from = name(first, !first.isSame(last, 'year'));
  return `Serveis logístics ${from} - ${name(last)}`;
}

/**
 * Concept printed on a logistics invoice's PDF: the tenant's text
 * (Configuració, `me.orders_options.invoice_concept`) and the orders' month,
 * «Serveis de Transport i Logística_Octubre_2026» (issues/312). Orders
 * spanning months read «…_Setembre_Octubre_2026», or «…_Desembre_2026_Gener_2027»
 * across years. Null without a text: the invoice then has no such concept.
 */
function invoicePdfConcept(orders, text) {
  const prefix = (text || '').trim();
  if (!prefix) return null;
  const { first, last } = monthRange(orders);
  const month = (m) => {
    const name = m.locale('ca').format('MMMM');
    return name.charAt(0).toUpperCase() + name.slice(1);
  };
  if (first.isSame(last, 'month')) return `${prefix}_${month(first)}_${first.year()}`;
  if (first.isSame(last, 'year')) return `${prefix}_${month(first)}_${month(last)}_${last.year()}`;
  return `${prefix}_${month(first)}_${first.year()}_${month(last)}_${last.year()}`;
}

module.exports = { orderLineConcept, invoiceConcept, invoicePdfConcept };
