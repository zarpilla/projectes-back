'use strict';

const moment = require('moment');

/**
 * Concept of the invoice line of an order: «Comanda 03/09/2026 | 23172 |
 * DJ - BCN CIUTAT». The date was written as stored (2026-09-03), unlike the
 * rest of the invoice (issues/111). A collection order's number carries «-R»,
 * as everywhere else (issues/298).
 */
const formatPercent = (value) => String(Math.round(Number(value) * 100) / 100).replace('.', ',');

function orderLineConcept(order) {
  const day = moment(order.estimated_delivery_date, 'YYYY-MM-DD', true);
  const date = day.isValid() ? day.format('DD/MM/YYYY') : order.estimated_delivery_date || '';
  const route = order.route && order.route.name;
  const number = `${String(order.id).padStart(4, '0')}${order.is_collection_order ? '-R' : ''}`;
  // a late order says why it costs more (issues/315)
  const surcharge = order.late_order && Number(order.late_surcharge) ? `Express +${formatPercent(order.late_surcharge)} %` : null;
  return [date ? `Comanda ${date}` : 'Comanda', number, route, surcharge].filter(Boolean).join(' | ');
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
 * Concept printed on a logistics invoice's PDF, from the tenant's text
 * (Configuració, `me.orders_options.invoice_concept`) and the orders' month
 * (issues/312). The text is a template:
 *   {Mes} Octubre · {mes} octubre · {MES} OCTUBRE · {mm} 10 · {any} 2026
 * so «Serveis logístics_{Mes}_{any}» gives «Serveis logístics_Octubre_2026».
 * Orders spanning months join them with «-»: {Mes} «Setembre-Octubre», and
 * {any} «2026-2027» across years. A text without placeholders gets
 * «_{Mes}_{any}» appended (the first version of the setting). Null without a
 * text: the invoice then has no such concept.
 */
const PLACEHOLDER = /\{(mes|Mes|MES|mm|any)\}/g;

function invoicePdfConcept(orders, text) {
  let template = (text || '').trim();
  if (!template) return null;
  if (!template.match(PLACEHOLDER)) template = `${template}_{Mes}_{any}`;
  const { first, last } = monthRange(orders);
  const both = (f) => (first.isSame(last, 'month') ? f(first) : `${f(first)}-${f(last)}`);
  const name = (m) => m.locale('ca').format('MMMM');
  const values = {
    mes: () => both(name),
    Mes: () => both((m) => name(m).charAt(0).toUpperCase() + name(m).slice(1)),
    MES: () => both((m) => name(m).toUpperCase()),
    mm: () => both((m) => m.format('MM')),
    any: () => (first.isSame(last, 'year') ? String(last.year()) : `${first.year()}-${last.year()}`),
  };
  return template.replace(PLACEHOLDER, (_, key) => values[key]());
}

module.exports = { orderLineConcept, invoiceConcept, invoicePdfConcept };
