'use strict';
/* global strapi */

/**
 * Grouped pickups (issues/429, Joel, la Diligència). A collection order
 * (XXXXX-R) gathers the farm pickups of one member, point, route and day.
 *
 * - Moving the -R (its day or its route) moves the pickup of every open order
 *   it collects, at once («en bloc»): the office used to open them one by one.
 *   The last edit wins: an order moved by itself before follows the block.
 * - A parcel is picked up before it is delivered: no pickup can fall after the
 *   expected delivery of its order. A block move that would leave one of its
 *   orders so is refused whole, naming the orders (the office moves those first,
 *   or one by one); an order's own pickup or delivery date is refused alike.
 *   The refusal carries the order ids in `details.orders` for the screen.
 * - Moving one order of the group by itself (its pickup day or route) already
 *   takes it out of the -R: it joins the -R of its new day and route, or a new
 *   one (lifecycles processCollectionOrder).
 */
const { toQueryDay } = require('../../../services/date-fields');
const { relationId } = require('../../../services/relation-input');

const ORDER = 'api::order.order';
// the orders still to be picked up and delivered: the others keep their dates
const SETTLED = ['cancelled', 'invoiced', 'delivered'];

const day = (value) => (value ? toQueryDay(value) : null);
const dayText = (value) => {
  const d = day(value);
  return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
};

/** The orders whose delivery comes before `pickupDay`: [{ id, estimated_delivery_date }]. */
function deliveredBeforePickup(orders, pickupDay) {
  const pickup = day(pickupDay);
  if (!pickup) return [];
  return (orders || []).filter((o) => {
    const delivery = day(o.estimated_delivery_date);
    return delivery && delivery < pickup;
  });
}

const refusal = (message, orders) => ({ message, details: { orders: orders.map((o) => o.id) } });

/** The open orders a collection order gathers. */
async function groupedOrders(collectionOrderId) {
  return strapi.db.query(ORDER).findMany({
    where: { collection_order: collectionOrderId, status: { $notIn: SETTLED } },
    select: ['id', 'estimated_delivery_date', 'collection_pickup_date', 'status'],
    populate: { collection_pickup_route: { select: ['id'] } },
    orderBy: { id: 'asc' },
  });
}

/**
 * The pickup day a save of the -R asks for, or null when it doesn't move it:
 * whichever of its two days was sent changed (the form sends both, one of them
 * as it was).
 */
function newCollectionDay(payload, stored) {
  const current = day(stored.collection_pickup_date || stored.estimated_delivery_date);
  for (const field of ['estimated_delivery_date', 'collection_pickup_date']) {
    if (payload[field] && day(payload[field]) !== current) return day(payload[field]);
  }
  return null;
}

/**
 * Why a save can't be done because a pickup would come after its delivery, or
 * null. `stored` is the order as it is, with is_collection_order, its dates and
 * collection_point.
 */
async function pickupOrderRefusal(orderId, payload, stored) {
  if (!payload || !stored) return null;
  if (stored.is_collection_order) {
    const moved = newCollectionDay(payload, stored);
    if (!moved) return null;
    const late = deliveredBeforePickup(await groupedOrders(orderId), moved);
    if (!late.length) return null;
    const list = late.map((o) => `${o.id} (entrega ${dayText(o.estimated_delivery_date)})`).join(', ');
    return refusal(
      `No es pot moure la recollida al ${dayText(moved)}: ${late.length === 1 ? 'la comanda' : 'les comandes'} ${list} ` +
        `${late.length === 1 ? "s'entrega" : "s'entreguen"} abans. Primer s'ha de recollir i després entregar: ` +
        `canvia abans la data d'entrega d'aquestes comandes o mou-les una per una.`,
      late,
    );
  }
  if (!('collection_pickup_date' in payload) && !('estimated_delivery_date' in payload)) return null;
  const hasPickup = relationId(payload.collection_point ?? stored.collection_point) || payload.collection_pickup_date;
  if (!hasPickup) return null;
  const pickup = day('collection_pickup_date' in payload ? payload.collection_pickup_date : stored.collection_pickup_date);
  const delivery = day(payload.estimated_delivery_date || stored.estimated_delivery_date);
  if (!pickup || !delivery || pickup <= delivery) return null;
  return refusal(
    `No es pot desar la comanda ${orderId}: la recollida (${dayText(pickup)}) seria després de l'entrega ` +
      `(${dayText(delivery)}). Primer s'ha de recollir i després entregar.`,
    [{ id: orderId }],
  );
}

/** The new order's pickup can't come after its delivery either. */
function newOrderPickupRefusal(payload) {
  if (!payload || !payload.collection_pickup_date || !payload.estimated_delivery_date) return null;
  if (!relationId(payload.collection_point)) return null;
  const pickup = day(payload.collection_pickup_date);
  const delivery = day(payload.estimated_delivery_date);
  if (pickup <= delivery) return null;
  return {
    message:
      `No es pot desar la comanda: la recollida (${dayText(pickup)}) seria després de l'entrega ` +
      `(${dayText(delivery)}). Primer s'ha de recollir i després entregar.`,
    details: { orders: [] },
  };
}

/**
 * After a -R moved (day or route): its open orders take its pickup day and
 * route. Generated updates (`_internal`): they stay in this -R.
 */
async function followCollectionMove(collectionOrderId, previous) {
  if (!previous) return 0;
  const current = await strapi.db.query(ORDER).findOne({
    where: { id: collectionOrderId },
    select: ['id', 'is_collection_order', 'estimated_delivery_date', 'collection_pickup_date'],
    populate: { route: { select: ['id'] } },
  });
  if (!current || !current.is_collection_order) return 0;
  const nowDay = day(current.collection_pickup_date || current.estimated_delivery_date);
  const beforeDay = day(previous.collection_pickup_date || previous.estimated_delivery_date);
  const nowRoute = relationId(current.route);
  const beforeRoute = relationId(previous.route);
  if (nowDay === beforeDay && nowRoute === beforeRoute) return 0;
  let moved = 0;
  for (const order of await groupedOrders(collectionOrderId)) {
    const data = {};
    if (nowDay && day(order.collection_pickup_date) !== nowDay) data.collection_pickup_date = nowDay;
    if (nowRoute && relationId(order.collection_pickup_route) !== nowRoute) data.collection_pickup_route = nowRoute;
    if (!Object.keys(data).length) continue;
    await strapi.db.query(ORDER).update({ where: { id: order.id }, data: { ...data, _internal: true } });
    moved += 1;
  }
  return moved;
}

/**
 * A -R has one day, its pickup: «Prevista» (estimated_delivery_date) and
 * collection_pickup_date. The list's quick edit sends the first, the form both
 * (one of them as it was): the one that moved is the new day of both.
 */
function alignCollectionDays(data, previous) {
  if (!previous || !previous.is_collection_order || data._internal) return;
  const moved = newCollectionDay(data, previous);
  if (!moved) return;
  data.estimated_delivery_date = moved;
  data.collection_pickup_date = moved;
}

module.exports = {
  deliveredBeforePickup,
  pickupOrderRefusal,
  newOrderPickupRefusal,
  followCollectionMove,
  alignCollectionDays,
  groupedOrders,
};
