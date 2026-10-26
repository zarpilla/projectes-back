'use strict';
/* global strapi */

/**
 * Startup script (issues/346, La Diligència, 2026-10-26): the late marks
 * written before the fix are judged again, and the wrong ones cleared.
 *
 * Two bugs marked orders late that were on time:
 *   - the afternoon routes were told by a time slot no route had, so a pickup
 *     on a «(TARDA)» route entered the day before after 13 h was late;
 *   - the server read the form's dates in UTC, a day early, so a member
 *     re-saving a Wednesday order on Monday afternoon made it late.
 *
 * First the routes named «TARDA» get «Ruta de tarda» (`afternoon`). Then every
 * order still open (not invoiced nor cancelled) with a mark is judged again as
 * if it had been entered when it was created, and its mark is cleared when it
 * was on time (late_order with its surcharge, late_pickup). A mark is never
 * added here, so the ones the office checked by hand on late orders stay.
 * Last, the collection orders (-R) of the cleared pickups are late only while
 * one of their orders still is.
 */
const { isLateDelivery, isLatePickup, lateRules } = require('./late-order');
const { getMe } = require('./me-settings');

const CLOSED = ['invoiced', 'cancelled'];

/** The routes to mark «Ruta de tarda»: named «TARDA», not marked yet. */
const afternoonRouteIds = (routes) =>
  routes.filter((r) => /\bTARDA\b/i.test(r.name || '') && !r.afternoon).map((r) => r.id);

/**
 * Which marks of these orders were wrong: judged as if entered when created.
 * A mark is only ever cleared, never added.
 */
function marksToClear(orders, rules, afternoonRoutes) {
  const orderIds = [];
  const pickupIds = [];
  for (const o of orders) {
    const entered = new Date(o.created_at);
    if (o.late_order && !isLateDelivery(o.estimated_delivery_date, entered, rules)) orderIds.push(o.id);
    const afternoon = afternoonRoutes.has(o.pickup_route);
    if (o.late_pickup && !isLatePickup(o.collection_pickup_date, entered, rules, { afternoon })) pickupIds.push(o.id);
  }
  return { orderIds, pickupIds };
}

async function markAfternoonRoutes(knex) {
  const routes = await knex('routes').select('id', 'name', 'afternoon');
  const ids = afternoonRouteIds(routes);
  if (!ids.length) return [];
  await knex('routes').whereIn('id', ids).update({ afternoon: true });
  strapi.log.info(`[recheckLateFlags] «Ruta de tarda» on routes ${ids.join(', ')}`);
  return ids;
}

async function recheckLateFlags() {
  const knex = strapi.db.connection;
  await markAfternoonRoutes(knex);

  const afternoonRoutes = new Set((await knex('routes').where('afternoon', true).select('id')).map((r) => r.id));
  const me = await getMe({ orders_options: true });
  const rules = lateRules(me && me.orders_options);

  const marked = await knex('orders as o')
    .leftJoin('orders_collection_pickup_route_lnk as pr', 'pr.order_id', 'o.id')
    .leftJoin('orders_collection_order_lnk as co', 'co.order_id', 'o.id')
    .where((q) => q.where('o.late_order', true).orWhere('o.late_pickup', true))
    // NULL on most orders: «not true» in SQL would skip them
    .where((q) => q.whereNull('o.is_collection_order').orWhere('o.is_collection_order', false))
    .whereNotIn('o.status', CLOSED)
    .select(
      'o.id',
      'o.created_at',
      'o.estimated_delivery_date',
      'o.collection_pickup_date',
      'o.late_order',
      'o.late_pickup',
      'pr.route_id as pickup_route',
      'co.inv_order_id as collection_order',
    );

  const { orderIds: clearedOrders, pickupIds: clearedPickups } = marksToClear(marked, rules, afternoonRoutes);
  if (clearedOrders.length) {
    await knex('orders').whereIn('id', clearedOrders).update({ late_order: false, late_surcharge: 0 });
  }
  if (clearedPickups.length) await knex('orders').whereIn('id', clearedPickups).update({ late_pickup: false });
  const collections = new Set(
    marked.filter((o) => clearedPickups.includes(o.id) && o.collection_order).map((o) => o.collection_order),
  );

  for (const id of collections) {
    const stillLate = await knex('orders as o')
      .join('orders_collection_order_lnk as co', 'co.order_id', 'o.id')
      .where('co.inv_order_id', id)
      .where('o.late_pickup', true)
      .whereNotIn('o.status', CLOSED)
      .first('o.id');
    await knex('orders').where('id', id).whereNotIn('status', CLOSED).update({ late_pickup: Boolean(stillLate) });
  }

  strapi.log.info(
    `[recheckLateFlags] ${marked.length} marked open orders; late order cleared: ${clearedOrders.join(', ') || 'none'}; ` +
      `late pickup cleared: ${clearedPickups.join(', ') || 'none'}; collection orders rechecked: ${[...collections].join(', ') || 'none'}`,
  );
  return { clearedOrders, clearedPickups, collections: [...collections] };
}

module.exports = { recheckLateFlags, afternoonRouteIds, marksToClear };
