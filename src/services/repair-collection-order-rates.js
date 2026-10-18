'use strict';
/* global strapi */

/**
 * Startup script (issues/151): the rate of a collection order was picked from
 * route rates read without their relations, so every rate looked like one for
 * every route and the first one won (on Diligència, rate 37, Girona, for
 * collection orders of every route). The price came from that rate.
 *
 * Collection orders not invoiced nor cancelled, and without an invoice, get
 * the rate the fixed selection gives and the price of that rate for their
 * kilograms (what updateCollectionOrderAggregates would write on their next
 * change). Invoiced ones are left as billed. Written straight to the tables:
 * the order lifecycles would recompute the aggregates and send notifications.
 *
 * Idempotent: only orders whose rate or price differ are touched.
 */
const {
  calculatePriceFromRouteRate,
  findCollectionOrderRouteRate,
} = require('../api/order/services/route-price');

const ORDER = 'api::order.order';
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

async function repairCollectionOrderRates() {
  const orders = await strapi.db.query(ORDER).findMany({
    where: { is_collection_order: true, status: { $notIn: ['invoiced', 'cancelled'] } },
    populate: {
      route: { select: ['id'] },
      delivery_type: { select: ['id'] },
      route_rate: { select: ['id'] },
      emitted_invoice: { select: ['id'] },
    },
  });

  const { tableName } = strapi.db.metadata.get(ORDER);
  const changed = [];
  for (const order of orders) {
    if (order.emitted_invoice) continue;
    const rate = await findCollectionOrderRouteRate(order);
    if (!rate) continue;
    const price = round2(calculatePriceFromRouteRate(rate, Number(order.kilograms) || 0, 0));
    const oldRate = order.route_rate ? order.route_rate.id : null;
    const oldPrice = order.price === null || order.price === undefined ? null : round2(order.price);
    if (oldRate === rate.id && oldPrice === price) continue;

    await strapi.db.connection(tableName).where({ id: order.id }).update({ price });
    if (oldRate !== rate.id) {
      await strapi.db.connection('orders_route_rate_lnk').where({ order_id: order.id }).del();
      await strapi.db.connection('orders_route_rate_lnk').insert({ order_id: order.id, route_rate_id: rate.id });
    }
    changed.push({ id: order.id, rate: [oldRate, rate.id], price: [oldPrice, price] });
  }

  strapi.log.info(
    `[repairCollectionOrderRates] ${changed.length} of ${orders.length} open collection orders repaired` +
      (changed.length
        ? `: ${changed.map((c) => `#${c.id} rate ${c.rate[0]}→${c.rate[1]} price ${c.price[0]}→${c.price[1]}`).join(', ')}`
        : ''),
  );
  return changed;
}

module.exports = { repairCollectionOrderRates };
