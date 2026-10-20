'use strict';
/* global strapi */

/**
 * The volume discount of a logistics order: a route's € off each order once
 * an owner has enough non-cancelled orders on it the same day. Shared by the
 * order lifecycles, which store it, and `checkMultidelivery`, which the order
 * form calls to preview it before saving (the form showed 11,56 € and the
 * saved order 9,56 €, issues/227). How it combines with the other discounts
 * is final-price.js (issues/057), untouched here.
 */
const { toQueryDay } = require('../../../services/date-fields');
const { relationId } = require('../../../services/relation-input');

// `pending`: orders not saved yet that will join the group (the rows of a CSV
// import being previewed, issues/298)
const checkVolumeDiscount = async (id, date, routeId, ownerId, currentStatus, pending = 0) => {
  // Find all orders for the same route, date, and owner (excluding cancelled and this order)
  const ordersOfDateRouteOwner = await strapi.db.query('api::order.order').findMany({
    where: { estimated_delivery_date: toQueryDay(date), route: routeId, owner: ownerId },
    // whether a sibling is on an invoice: it keeps its discount (issues/286)
    populate: { emitted_invoice: { select: ['id'] } },
  });

  const others = ordersOfDateRouteOwner.filter(
    (o) => o.id.toString() !== id.toString() && o.status !== 'cancelled',
  );

  // Get the route entity for discount config
  let route = null;
  if (routeId) {
    route = await strapi.db.query('api::route.route').findOne({ where: { id: routeId } });
  }

  let discount = 0;
  let eligible = false;
  if (route && route.volume_discount_number_of_orders > 0 && route.volume_discount_price > 0) {
    // Count current + others (if not cancelled)
    const count =
      (currentStatus !== 'cancelled' ? 1 : 0) + others.filter((o) => o.status !== 'cancelled').length + pending;
    if (count >= route.volume_discount_number_of_orders) {
      discount = route.volume_discount_price;
      eligible = true;
    }
  }
  return {
    others,
    eligible,
    discount,
  };
};

/**
 * The volume discount the lifecycle stores on the order being saved (`data`:
 * its route, owner, date and status), or undefined when it keeps the stored
 * one: invoiced or delivered orders, or one of those fields missing.
 */
const currentOrderVolumeDiscount = async (orderId, data, pending = 0) => {
  // Skip if order is invoiced or delivered
  if (data.status === 'invoiced' || data.status === 'delivered') return undefined;
  // Only if route, owner, and date are present
  if (!data.route || !data.owner || !data.estimated_delivery_date) return undefined;
  const { eligible, discount } = await checkVolumeDiscount(
    orderId || 0,
    data.estimated_delivery_date,
    relationId(data.route),
    relationId(data.owner),
    data.status,
    pending,
  );
  return eligible ? discount : 0;
};

module.exports = { checkVolumeDiscount, currentOrderVolumeDiscount };
