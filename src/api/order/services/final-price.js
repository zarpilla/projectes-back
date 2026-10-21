'use strict';

/**
 * The discounted price of a logistics order, the one formula shared by the
 * orders list (`finalPrice`), the stats (`infoAll`) and the invoice lines
 * (issues/057, 145). The front's copy is `invoicedPrice` in
 * projectes-front `src/domain/logisticsInvoicing.js`.
 *
 *   (price − volume discount €) × (1 + late surcharge % / 100)
 *     × (1 − (multidelivery % + pickup %) / 100)
 *
 * The surcharge of a late order (issues/315, «Recàrrec per incidència») is
 * part of the line's base, rounded to cents, so the invoice shows the
 * surcharged price and the discounts as they were.
 *
 * It is what the invoice has always charged: the line's base is the price
 * less the volume discount and its discount is the sum of both percentages,
 * which the document lifecycle (computeLineTotals) applies and rounds to
 * cents. The list compounded the percentages before subtracting the volume
 * discount and the stats compounded them after it, so the same order showed
 * three amounts. Already issued invoices are not touched.
 *
 * finalPrice is not stored: v3 computed it in an afterFind hook on every query;
 * v5 has none, so every handler that returns order rows applies it here.
 */

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/** The late surcharge % an order pays (issues/315): only while it is marked late. */
function lateSurchargeOf(order) {
  const o = order || {};
  return o.late_order ? Number(o.late_surcharge) || 0 : 0;
}

/** The invoice line of an order: base (price − volume discount, plus the late surcharge) and discount %. */
function orderInvoiceLine(order) {
  const o = order || {};
  const base = (Number(o.price) || 0) - (Number(o.volume_discount) || 0);
  const surcharge = lateSurchargeOf(o);
  return {
    base: surcharge ? round2(base * (1 + surcharge / 100)) : base,
    discount: (Number(o.multidelivery_discount) || 0) + (Number(o.contact_pickup_discount) || 0),
  };
}

/** The amount the invoice line of the order comes to, rounded to cents as the invoice does. */
function orderDiscountedPrice(order) {
  const { base, discount } = orderInvoiceLine(order);
  // same operations as computeLineTotals (quantity 1), so the cents agree
  let amount = base * 1;
  if (discount) amount = amount * (1 - discount / 100.0);
  return round2(amount);
}

function applyFinalPrice(order) {
  if (!order) return order;
  order.finalPrice = orderDiscountedPrice(order);
  return order;
}

/** Applies it to a list, tolerating holes. */
function applyFinalPriceToAll(orders) {
  if (!Array.isArray(orders)) return orders;
  for (const order of orders) applyFinalPrice(order);
  return orders;
}

module.exports = { applyFinalPrice, applyFinalPriceToAll, lateSurchargeOf, orderDiscountedPrice, orderInvoiceLine };
