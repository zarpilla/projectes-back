'use strict';

const { orderDiscountedPrice } = require('./final-price');

/**
 * The figures above the orders list (Comandes), over every order that matches
 * its filters (issues/177). The list summed only the page it had loaded (150
 * rows), so on a tab with more orders the kilos and the amount looked like
 * totals and weren't.
 *
 * Cancelled orders are counted apart and add nothing. An order is
 * refrigerated by its own flag (issues/178): the one the delivery note and the
 * invoice print, set from the delivery type on save and, on a collection
 * order, from the orders it collects.
 */
const TOTALS_SELECT = [
  'id',
  'status',
  'units',
  'kilograms',
  'price',
  'volume_discount',
  'multidelivery_discount',
  'contact_pickup_discount',
  'late_order',
  'late_surcharge',
  'refrigerated',
  'transfer',
  'deposit_date',
];

const round = (v, d = 2) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d;

function orderTotals(orders) {
  const t = {
    active: 0,
    cancelled: 0,
    units: 0,
    kg: 0,
    price: 0,
    refrigerated: 0,
    transfers: 0,
    pickups: 0,
    deposited: 0,
  };
  for (const o of orders || []) {
    if (o.status === 'cancelled') {
      t.cancelled++;
      continue;
    }
    t.active++;
    t.units += Number(o.units) || 0;
    t.kg += Number(o.kilograms) || 0;
    t.price += orderDiscountedPrice(o);
    if (o.refrigerated) t.refrigerated++;
    if (o.transfer) t.transfers++;
    if (o.pickup && o.pickup.pickup) t.pickups++;
    if (o.deposit_date) t.deposited++;
  }
  return { ...t, kg: round(t.kg), price: round(t.price) };
}

module.exports = { orderTotals, TOTALS_SELECT };
