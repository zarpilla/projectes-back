'use strict';

/**
 * finalPrice: base price with the multidelivery and pickup discounts (percent)
 * and the volume discount (fixed). Ported verbatim from the v3 afterFind hook.
 *
 * v3 ran that hook on EVERY query, so finalPrice was on an order however it was
 * fetched. v5 has no afterFind, and the port applied it only in find/findOne --
 * so /api/orders/table, which is what the orders list actually calls, returned
 * rows without it and the Preu column rendered "?" on every row.
 *
 * Kept here so the arithmetic is testable and every handler that returns order
 * rows can share one implementation.
 */
function applyFinalPrice(order) {
  if (!order) return order;
  let price = order.price || 0;
  price = price * (1 - (order.multidelivery_discount || 0) / 100);
  price = price * (1 - (order.contact_pickup_discount || 0) / 100);
  price = price - (order.volume_discount || 0);
  order.finalPrice = price;
  return order;
}

/** Applies it to a list, tolerating holes. */
function applyFinalPriceToAll(orders) {
  if (!Array.isArray(orders)) return orders;
  for (const order of orders) applyFinalPrice(order);
  return orders;
}

module.exports = { applyFinalPrice, applyFinalPriceToAll };
