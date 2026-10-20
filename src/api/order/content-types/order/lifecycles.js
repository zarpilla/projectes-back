'use strict';
/* global strapi */

/**
 * order lifecycles (v5). Ported from v3 api/orders/models/orders.js (1,839 LOC).
 * Volume/multidelivery discounts, collection-order aggregation, transfer-route
 * calculation, tracking, incidences. Helper logic preserved verbatim; hooks
 * converted to (event) signatures; cross-hook data via event.state.
 */

const _ = require('lodash');
const moment = require('moment');
const { toQueryDay } = require('../../../../services/date-fields');
const { relationId } = require('../../../../services/relation-input');
const {
  calculatePriceFromRouteRate,
  fillMissingPrice,
  findCollectionOrderRouteRate,
} = require('../../services/route-price');
const { loadRouteClosures, nextRouteDay, routeRunsOn } = require('../../services/route-days');
const { checkVolumeDiscount, currentOrderVolumeDiscount } = require('../../services/volume-discount');
const { getMe } = require('../../../../services/me-settings');
const { errors: { ApplicationError } } = require('@strapi/utils');

/**
 * Safely extract ID from a value that could be a number, string, or object with an id property
 * Returns null if the value is not a valid ID
 */
// Statuses that make an order untouchable. A collection order in
// delivered/lastmile/processed/pending is still reusable; only these two are
// final. Named once so the four call sites cannot drift apart.
const CLOSED_STATUSES = ['cancelled', 'invoiced'];

// The statuses of an order that is not delivered yet (issues/266).
const PRE_DELIVERY_STATUSES = ['pending', 'deposited', 'processed', 'distributing', 'lastmile'];

const extractId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  // If it's already a number or numeric string, use it
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
    const numValue = typeof value === 'number' ? value : parseInt(value, 10);
    return !isNaN(numValue) && numValue > 0 ? numValue : null;
  }
  // If it's an object, try to extract the id property
  if (typeof value === 'object' && value.id !== undefined) {
    return extractId(value.id);
  }
  // v5 hands db lifecycles relations as operations — { set: [{ id }] } or
  // { connect: … }. Read as "no id", the owner of every saved order came out
  // null and its multidelivery discount was never recomputed.
  if (typeof value === 'object' && (value.set !== undefined || value.connect !== undefined)) {
    return extractId(relationId(value));
  }
  // Otherwise, it's not a valid ID
  return null;
};
const normalizeOrderDate = (value) => {
  if (!value) return null;
  // the Madrid day, not the UTC one the first 10 characters give (issues/233)
  return toQueryDay(value);
};

// A farm pickup can't be planned for a day already gone, whoever saves it:
// order 25432 was saved on 2026-10-19 with its pickup on the 13th and got a
// collection order for that day (issues/302). On update only a moved date is
// checked, so an order whose pickup has passed still saves as it is.
const refusePastPickupDate = (data, previousOrder = null) => {
  if (data._internal || !data.collection_pickup_date) return;
  if (data.is_collection_order || (previousOrder && previousOrder.is_collection_order)) return;
  const day = normalizeOrderDate(data.collection_pickup_date);
  if (previousOrder && normalizeOrderDate(previousOrder.collection_pickup_date) === day) return;
  if (day < toQueryDay(new Date())) {
    throw new ApplicationError(`La data de recollida (${moment(day).format('DD/MM/YYYY')}) ja ha passat`);
  }
};

// A sibling that is invoiced, delivered or already on an invoice keeps the
// discount it was charged with: repricing it left the order disagreeing with
// its invoice line (issues/233). It still counts towards the group. The same
// holds for the volume discount (issues/286).
const FROZEN_DISCOUNT_STATUSES = ['invoiced', 'delivered'];
const repriceable = (orders) =>
  orders.filter((o) => !FROZEN_DISCOUNT_STATUSES.includes(o.status) && !relationId(o.emitted_invoice));

// --- VOLUME DISCOUNT LOGIC ---
// checkVolumeDiscount: services/volume-discount.js (the order form previews it, issues/227)
const updateVolumeDiscountForOrders = async (orders, discount) => {
  for await (const order of repriceable(orders)) {
    if (order.volume_discount !== discount) {
      await strapi
        .query('api::order.order')
        .update({ where: { id: order.id }, data: { volume_discount: discount, _internal: true } });
    }
  }
};

const processVolumeDiscountForCurrentOrder = async (orderId, data) => {
  if (data._internal) return;
  const discount = await currentOrderVolumeDiscount(orderId, data);
  if (discount !== undefined) data.volume_discount = discount;
};

const processVolumeDiscountForOtherOrders = async (orderId, currentData, previousOrder = null) => {
  if (currentData._internal) return;

  // Skip if order is invoiced or delivered
  if (currentData.status === 'invoiced' || currentData.status === 'delivered') {
    return;
  }

  if (!currentData.route || !currentData.owner || !currentData.estimated_delivery_date) return;
  const routeId = currentData.route.id ? currentData.route.id : currentData.route;
  const ownerId = currentData.owner.id ? currentData.owner.id : currentData.owner;
  const { eligible, discount, others } = await checkVolumeDiscount(
    orderId,
    currentData.estimated_delivery_date,
    routeId,
    ownerId,
    currentData.status,
  );
  if (eligible && others.length > 0) {
    await updateVolumeDiscountForOrders(others, discount);
  } else if (!eligible && others.length > 0) {
    // Remove discount from others if not eligible
    for await (const order of repriceable(others)) {
      if (order.volume_discount > 0) {
        await strapi
          .query('api::order.order')
          .update({ where: { id: order.id }, data: { volume_discount: 0, _internal: true } });
      }
    }
  }
  // If previousOrder exists and key fields changed, update previous group
  if (previousOrder && orderId !== 0) {
    const dateChanged = previousOrder.estimated_delivery_date !== currentData.estimated_delivery_date;
    const routeChanged = extractId(previousOrder.route) !== extractId(currentData.route);
    const ownerChanged = extractId(previousOrder.owner) !== extractId(currentData.owner);
    const statusChanged = previousOrder.status !== currentData.status;
    if (dateChanged || routeChanged || ownerChanged || statusChanged) {
      if (dateChanged || routeChanged || ownerChanged) {
        // Check previous group
        const prevRouteId = extractId(previousOrder.route);
        const prevOwnerId = extractId(previousOrder.owner);
        const prevGroup = await checkVolumeDiscount(
          orderId,
          previousOrder.estimated_delivery_date,
          prevRouteId,
          prevOwnerId,
          'active',
        );
        if (prevGroup.others.length > 0) {
          const count = prevGroup.others.length;
          const prevRoute = await strapi.db.query('api::route.route').findOne({ where: { id: prevRouteId } });
          if (
            prevRoute &&
            prevRoute.volume_discount_number_of_orders > 0 &&
            prevRoute.volume_discount_price > 0 &&
            count < prevRoute.volume_discount_number_of_orders
          ) {
            // Remove discount from previous group
            for await (const order of repriceable(prevGroup.others)) {
              if (order.volume_discount > 0) {
                await strapi
                  .query('api::order.order')
                  .update({ where: { id: order.id }, data: { volume_discount: 0, _internal: true } });
              }
            }
          } else if (
            prevRoute &&
            prevRoute.volume_discount_number_of_orders > 0 &&
            prevRoute.volume_discount_price > 0 &&
            count >= prevRoute.volume_discount_number_of_orders
          ) {
            await updateVolumeDiscountForOrders(prevGroup.others, prevRoute.volume_discount_price);
          }
        }
      }
    }
  }
};

/**
 * The relations the multidelivery / volume grouping keys on. v3 returned them
 * as FK columns on every row; v5 omits an unpopulated relation, so the rows
 * the hooks re-read had no contact / owner / route and the discount of the
 * OTHER orders in the old and new date groups was never updated.
 */
const DISCOUNT_RELATIONS = { contact: true, owner: true, route: true };

const findWithDiscountRelations = (id) =>
  strapi.db.query('api::order.order').findOne({ where: { id }, populate: DISCOUNT_RELATIONS });

/**
 * The relations the collection-order hooks read off a re-read order row.
 * Unpopulated in v5 they are undefined, so afterUpdate saw no
 * collection_point (an edited order was never regrouped) and no
 * collection_order (the collection order's totals and auto-deposit were never
 * refreshed after a create, an edit or a delete).
 */
const COLLECTION_RELATIONS = {
  collection_point: true,
  collection_order: true,
  collection_pickup_route: true,
  owner: true,
  route: true,
  pickup: true,
  delivery_type: true,
};

const findWithCollectionRelations = (id) =>
  strapi.db.query('api::order.order').findOne({ where: { id }, populate: COLLECTION_RELATIONS });

const checkMultidelivery = async (id, date, contactId, currentStatus) => {
  const ordersOfDateAndContact = await strapi.db.query('api::order.order').findMany({
    where: { estimated_delivery_date: toQueryDay(date), contact: contactId },
    // whether a sibling is on an invoice (issues/233)
    populate: { emitted_invoice: { select: ['id'] } },
  });

  const others = ordersOfDateAndContact.filter(
    (o) => o.id.toString() !== id.toString() && o.status !== 'cancelled',
  );

  return {
    others,
    multidelivery:
      (currentStatus === 'cancelled' && others.length > 1) ||
      (currentStatus !== 'cancelled' && others.length > 0),
  };
};

const setDeliveryTypeRefrigerated = async (data) => {
  // v3's service.find() returned an array; v5's returns { results, pagination }.
  // Go to db.query for the plain rows.
  const id = relationId(data.delivery_type);
  if (!id) return;
  const deliveryType = await strapi.db
    .query('api::delivery-type.delivery-type')
    .findOne({ where: { id } });
  data.refrigerated = deliveryType && deliveryType.refrigerated ? 1 : 0;
};

/**
 * Normalize contact_legal_form to ensure it's never an empty object or invalid value
 */
const normalizeContactLegalForm = (data) => {
  // Check if contact_legal_form exists and is an object (including empty objects)
  if (data.contact_legal_form !== undefined && data.contact_legal_form !== null) {
    if (typeof data.contact_legal_form === 'object') {
      // It's an object - check if it has an id property
      if (relationId(data.contact_legal_form) !== undefined) {
        data.contact_legal_form = relationId(data.contact_legal_form);
      } else {
        // Empty object or object without id - set to default
        data.contact_legal_form = 1;
      }
    } else if (data.contact_legal_form === 0 || data.contact_legal_form === '') {
      // Zero or empty string - set to default
      data.contact_legal_form = 1;
    }
    // If it's already a valid number, leave it as is
  } else {
    // Null or undefined - set to default
    data.contact_legal_form = 1;
  }
};

/**
 * Enforce collection-order specific field rules
 */
const enforceCollectionOrderFields = async (data, previousOrder = null) => {
  const isCollectionOrder =
    data.is_collection_order === true || (previousOrder && previousOrder.is_collection_order === true);

  if (!isCollectionOrder) {
    return;
  }

  data.collection_point = null;
  data.collection_pickup_route = null;

  const routeId = extractId(data.route) || extractId(previousOrder && previousOrder.route);
  if (!routeId) {
    return;
  }

  const route = await strapi.db
    .query('api::route.route')
    .findOne({ where: { id: routeId }, populate: { transfer_pickup: true } });
  const transferPickupId = route ? extractId(route.transfer_pickup) : null;

  if (transferPickupId) {
    data.pickup = transferPickupId;
  }
};

// --- COLLECTION ORDER LOGIC ---

/**
 * Calculate route for a collection point contact based on its city
 */
const calculateRouteForCollectionPoint = async (collectionPointContact) => {
  if (!collectionPointContact || !collectionPointContact.city) {
    return null;
  }

  // Find city object by name
  const cities = await strapi.db
    .query('api::city.city')
    .findMany({ where: { name: collectionPointContact.city }, limit: 1 });
  if (!cities || cities.length === 0) {
    return null;
  }
  const cityId = cities[0].id;

  // Find route that serves this city
  const cityRoutes = await strapi.db
    .query('api::city-route.city-route')
    // `cr.route` is dereferenced below; unpopulated it is undefined, every id
    // is filtered out and this returns null ("Could not find route for
    // collection point").
    .findMany({ where: { city: cityId }, populate: { route: true } });
  if (!cityRoutes || cityRoutes.length === 0) {
    return null;
  }

  // Extract route IDs properly
  const routeIds = cityRoutes
    .map((cr) => {
      if (typeof cr.route === 'object' && cr.route !== null) {
        return cr.route.id;
      }
      return cr.route;
    })
    .filter((id) => id !== null && id !== undefined && typeof id === 'number');

  if (routeIds.length === 0) {
    return null;
  }

  // Get the first active route
  const routes = await strapi.db
    .query('api::route.route')
    .findMany({
      where: { id: { $in: routeIds }, active: true },
      populate: { transfer_pickup: true },
      limit: 1,
    });

  return routes && routes.length > 0 ? routes[0] : null;
};

/**
 * Estimated delivery date of a collection order without one: the route's next
 * open day after today. It took the route's first weekday only (Sunday never
 * matched) and ignored its closures (issues/156).
 */
const calculateEstimatedDeliveryDate = async (route) => (route ? nextRouteDay(route) : null);

/**
 * Check if transfer is needed for a collection order
 */
const checkTransferNeededForCollectionOrder = async (pickupId, routeId, orderData = null) => {
  if (!pickupId || !routeId) {
    return { transfer: false };
  }

  // Get pickup details. `city` and `transfer_pickup` are relations: v5 leaves
  // them off the row unless populated, so no pickup had a town (no transfer
  // seen) and every transfer was saved without a destination (issues/156).
  const pickup = await strapi.db
    .query('api::pickup.pickup')
    .findOne({ where: { id: pickupId }, populate: { city: true } });
  if (!pickup) {
    return { transfer: false };
  }

  // Get route details
  const route = await strapi.db
    .query('api::route.route')
    .findOne({ where: { id: routeId }, populate: { transfer_pickup: true } });
  if (!route) {
    return { transfer: false };
  }

  let pickupCityId = null;

  // If this is a "Recollida en Finca" pickup (pickup: true), get city from collection_point contact
  if (pickup.pickup === true && orderData && orderData.collection_point) {
    const collectionPointId = extractId(orderData.collection_point);

    if (collectionPointId) {
      const collectionPointContact = await strapi.db
        .query('api::contact.contact')
        .findOne({ where: { id: collectionPointId } });
      if (collectionPointContact && collectionPointContact.city) {
        // Find city object by name
        const cities = await strapi.db
          .query('api::city.city')
          .findMany({ where: { name: collectionPointContact.city }, limit: 1 });
        if (cities && cities.length > 0) {
          pickupCityId = cities[0].id;
        }
      }
    }
  }

  // Fallback: Get city from pickup if not already set
  if (!pickupCityId && pickup.city) {
    pickupCityId = typeof pickup.city === 'object' ? pickup.city.id : pickup.city;
  }

  if (!pickupCityId) {
    return { transfer: false };
  }

  // Check if route serves this city
  const cityRoutes = await strapi.db
    .query('api::city-route.city-route')
    .findMany({ where: { city: pickupCityId, route: routeId }, limit: 1 });

  const routeTravelsToCity = cityRoutes && cityRoutes.length > 0;

  if (!routeTravelsToCity) {
    // Transfer is needed
    return {
      transfer: true,
      transfer_pickup_origin: pickupId,
      transfer_pickup_destination: extractId(route.transfer_pickup),
    };
  }

  return { transfer: false };
};

/**
 * Calculate transfer route and date for orders that need a transfer
 * Finds an active transfer route that operates on or before the estimated delivery date,
 * and not before `notBefore` (the farm pickup of the order, collection_pickup_date): the
 * transfer of order 24946 was planned the day before its boxes were picked up (issues/227).
 */
const calculateTransferRoute = async (estimatedDeliveryDate, notBefore = null) => {
  if (!estimatedDeliveryDate) {
    return { transfer_route: null, transfer_route_date: null };
  }

  // Get all active transfer routes
  const transferRoutes = await strapi.db
    .query('api::route.route')
    .findMany({ where: { is_transfer_route: true, active: true } });

  if (!transferRoutes || transferRoutes.length === 0) {
    return { transfer_route: null, transfer_route_date: null };
  }

  // Start from the estimated delivery date and work backwards. A transfer
  // route runs on each of its weekdays, not only the first one, and not on
  // the days it is closed (issues/156).
  const maxIterations = 14; // Check up to 2 weeks back
  const deliveryDay = moment(estimatedDeliveryDate).startOf('day');
  const closures = await loadRouteClosures(
    deliveryDay.clone().subtract(maxIterations, 'days'),
    deliveryDay,
  );
  const currentDate = deliveryDay.clone();
  const earliest = notBefore ? moment(notBefore).format('YYYY-MM-DD') : null;

  for (let iterations = 0; iterations < maxIterations; iterations++) {
    if (earliest && currentDate.format('YYYY-MM-DD') < earliest) break;
    const isSameDay = currentDate.isSame(deliveryDay, 'day');

    for (const route of transferRoutes) {
      if (!routeRunsOn(route, currentDate, closures)) continue;
      // Date restriction based on is_transfer_route_date; null accepts any day
      if (route.is_transfer_route_date === 'only_same_day' && !isSameDay) continue;
      if (route.is_transfer_route_date === 'only_previous_days' && isSameDay) continue;

      return {
        transfer_route: route.id,
        transfer_route_date: currentDate.format('YYYY-MM-DD'),
      };
    }

    currentDate.subtract(1, 'day');
  }

  // No transfer route found
  return { transfer_route: null, transfer_route_date: null };
};

/**
 * Calculate transfer data for an order without updating it
 * Returns the transfer fields to be set on the order
 */
const calculateOrderTransferData = async (orderData) => {
  // Skip if this is a collection order
  if (orderData.is_collection_order) {
    return {};
  }

  // Only process if we have the necessary data
  const pickupId = extractId(orderData.pickup);
  const routeId = extractId(orderData.route);
  const estimatedDeliveryDate = orderData.estimated_delivery_date;

  if (!pickupId || !routeId || !estimatedDeliveryDate) {
    return {};
  }

  // Check if transfer is needed
  const transferInfo = await checkTransferNeededForCollectionOrder(pickupId, routeId, orderData);

  // If the order needs a transfer
  if (transferInfo.transfer) {
    // Calculate transfer route
    const transferRouteInfo = await calculateTransferRoute(
      estimatedDeliveryDate,
      orderData.collection_pickup_date,
    );

    return {
      transfer: true,
      transfer_pickup_origin: transferInfo.transfer_pickup_origin,
      transfer_pickup_destination: transferInfo.transfer_pickup_destination,
      transfer_route: transferRouteInfo.transfer_route,
      transfer_route_date: transferRouteInfo.transfer_route_date,
    };
  } else {
    // Clear transfer fields if no transfer is needed
    return {
      transfer: false,
      transfer_pickup_origin: null,
      transfer_pickup_destination: null,
      transfer_route: null,
      transfer_route_date: null,
    };
  }
};

// An order in one of these statuses keeps its transfer fields (issues/296).
const TRANSFER_FROZEN_STATUSES = ['delivered', 'invoiced', 'cancelled'];

/**
 * Whether an update really changes what the transfer is computed from: the
 * pickup, the route, the collection point or the dates. A field sent with
 * its stored value is no change (issues/296).
 */
const transferFieldsChanged = (data, previousOrder) => {
  const prev = previousOrder || {};
  const relationChanged = (field) =>
    data[field] !== undefined && extractId(data[field]) !== extractId(prev[field]);
  const dayChanged = (field) =>
    data[field] !== undefined && normalizeOrderDate(data[field]) !== normalizeOrderDate(prev[field]);
  return (
    relationChanged('pickup') ||
    relationChanged('route') ||
    relationChanged('collection_point') ||
    dayChanged('estimated_delivery_date') ||
    dayChanged('collection_pickup_date')
  );
};

// What the transfer recompute writes (calculateOrderTransferData)
const TRANSFER_COMPUTED_FIELDS = [
  'transfer',
  'transfer_pickup_origin',
  'transfer_pickup_destination',
  'transfer_route',
  'transfer_route_date',
];
const TRANSFER_RELATIONS = ['transfer_pickup_origin', 'transfer_pickup_destination', 'transfer_route'];

/**
 * Drop the transfer fields a save sends with another value than the stored
 * one. The order form recomputed the transfer when it loaded an order and
 * sent it back with a save without changes, so a processed or invoiced order
 * became a transfer dated in the past (issues/296).
 */
const keepStoredTransfer = async (data, orderId) => {
  const sent = TRANSFER_COMPUTED_FIELDS.filter((field) => data[field] !== undefined);
  if (!sent.length) return;
  const stored =
    (await strapi.db.query('api::order.order').findOne({
      where: { id: orderId },
      populate: Object.fromEntries(TRANSFER_RELATIONS.map((field) => [field, { select: ['id'] }])),
    })) || {};
  const same = (field) => {
    if (field === 'transfer') return Boolean(data.transfer) === Boolean(stored.transfer);
    if (field === 'transfer_route_date') {
      return normalizeOrderDate(data[field]) === normalizeOrderDate(stored[field]);
    }
    return (extractId(data[field]) || null) === (extractId(stored[field]) || null);
  };
  const dropped = sent.filter((field) => !same(field));
  if (!dropped.length) return;
  strapi.log.warn(`order ${orderId}: transfer kept, sent ${dropped.join(', ')} dropped`);
  for (const field of dropped) delete data[field];
};

/**
 * Process collection order: find or create a collection order for the collection point
 * NOTE: This function should NEVER be called for orders where is_collection_order=true
 * Collection orders themselves should never create or link to other collection orders
 */
const processCollectionOrder = async (orderId, orderData, previousOrderData = null) => {
  // Skip if no collection_point or if this is already a collection order
  // IMPORTANT: Collection orders (is_collection_order=true) must never process themselves
  // to prevent infinite loops or duplicate collection orders
  if (!orderData.collection_point || orderData.is_collection_order) {
    return;
  }
  // a cancelled order leaves its collection order (updateCollectionOrderAggregates
  // cancels it when it was the last one) and gets no new one: saving it again
  // found its collection order cancelled and generated another (issues/217)
  if (orderData.status === 'cancelled') {
    return;
  }

  const collectionPointId = extractId(orderData.collection_point);
  const ownerId = extractId(orderData.owner);

  // If the order already has a collection_order, check if we should keep it
  if (previousOrderData && previousOrderData.collection_order) {
    const existingCollectionOrderId = extractId(previousOrderData.collection_order);

    // Get the existing collection order
    const existingCollectionOrder = await strapi.db
      .query('api::order.order')
      .findOne({ where: { id: existingCollectionOrderId } });

    // Only reprocess if:
    // 1. The collection order was cancelled
    // 2. Key fields have changed (collection_point, collection_pickup_route, collection_pickup_date)
    const collectionPointChanged = extractId(previousOrderData.collection_point) !== collectionPointId;
    const routeChanged =
      extractId(previousOrderData.collection_pickup_route) !== extractId(orderData.collection_pickup_route);
    // the pickup day: its own, or the delivery day of an order without one
    // (the -R is grouped by it below); moving the delivery date of such an
    // order left it in the -R of the old day (issues/292)
    const pickupDay = (o) => normalizeOrderDate(o.collection_pickup_date || o.estimated_delivery_date);
    const dateChanged = pickupDay(previousOrderData) !== pickupDay(orderData);

    if (existingCollectionOrder) {
      // If the collection order is cancelled, we need to create/find a new one
      if (existingCollectionOrder.status === 'cancelled') {
        // Continue with processing to find/create a new collection order
      }
      // If key fields haven't changed and collection order is not cancelled, keep the existing one
      else if (!collectionPointChanged && !routeChanged && !dateChanged) {
        // Nothing to do - keep existing collection order
        return;
      }
      // If key fields changed, continue with processing to find/create appropriate collection order
    }
  }

  if (!collectionPointId || !ownerId) {
    return;
  }

  // Get collection point contact details
  const collectionPointContact = await strapi.db
    .query('api::contact.contact')
    .findOne({ where: { id: collectionPointId } });
  if (!collectionPointContact) {
    console.error(`Collection point contact ${collectionPointId} not found`);
    return;
  }

  // Determine route and date for collection order
  let route;
  let estimatedDeliveryDate = null;
  let collectionPickupDate = null;

  if (orderData.collection_pickup_route) {
    // Use the route specified by the frontend
    const routeId = extractId(orderData.collection_pickup_route);
    // transfer_pickup is dereferenced further down to choose the collection
    // order's warehouse.
    route = await strapi.db
    .query('api::route.route')
    .findOne({ where: { id: routeId }, populate: { transfer_pickup: true } });

    // Use date from frontend if provided
    if (orderData.collection_pickup_date) {
      collectionPickupDate = toQueryDay(orderData.collection_pickup_date);
      estimatedDeliveryDate = collectionPickupDate;
    } else {
      // Fallback priority when collection_pickup_date is missing:
      // 1) main order collection pickup date (if present)
      // 2) main order estimated delivery date
      // 2) existing linked collection order date
      // 3) route next-day calculation (last resort)
      if (orderData.collection_pickup_date) {
        collectionPickupDate = toQueryDay(orderData.collection_pickup_date);
      }

      if (orderData.estimated_delivery_date) {
        estimatedDeliveryDate = toQueryDay(orderData.estimated_delivery_date);
      }

      if (!estimatedDeliveryDate) {
        const existingCollectionOrderId = extractId(orderData.collection_order);

        if (existingCollectionOrderId) {
          const existingCollectionOrder = await strapi.db
            .query('api::order.order')
            .findOne({ where: { id: existingCollectionOrderId } });

          if (existingCollectionOrder && existingCollectionOrder.collection_pickup_date) {
            collectionPickupDate = toQueryDay(existingCollectionOrder.collection_pickup_date);
          }

          if (existingCollectionOrder && existingCollectionOrder.estimated_delivery_date) {
            estimatedDeliveryDate = toQueryDay(existingCollectionOrder.estimated_delivery_date);
          }
        }
      }

      if (!estimatedDeliveryDate) {
        estimatedDeliveryDate = await calculateEstimatedDeliveryDate(route);
      }

      if (!collectionPickupDate) {
        collectionPickupDate = estimatedDeliveryDate;
      }
    }
  } else {
    // Fallback to automatic calculation
    route = await calculateRouteForCollectionPoint(collectionPointContact);
    if (route) {
      if (orderData.collection_pickup_date) {
        collectionPickupDate = toQueryDay(orderData.collection_pickup_date);
        estimatedDeliveryDate = collectionPickupDate;
      } else if (orderData.estimated_delivery_date) {
        estimatedDeliveryDate = toQueryDay(orderData.estimated_delivery_date);
        collectionPickupDate = estimatedDeliveryDate;
      } else {
        estimatedDeliveryDate = await calculateEstimatedDeliveryDate(route);
        collectionPickupDate = estimatedDeliveryDate;
      }
    }
  }

  if (!route) {
    console.error(`Could not find route for collection point ${collectionPointId}`);
    return;
  }

  if (!estimatedDeliveryDate) {
    return;
  }

  if (!collectionPickupDate) {
    collectionPickupDate = estimatedDeliveryDate;
  }

  const groupingRouteId = route.id;

  // Find existing collection order for this owner, collection point, route, and date
  // Deterministic search (oldest first) to avoid non-deterministic reuse
  const groupingCriteria = {
    owner: ownerId,
    contact: collectionPointId,
    collection_pickup_route: groupingRouteId,
    route: route.id,
    collection_pickup_date: collectionPickupDate,
    estimated_delivery_date: estimatedDeliveryDate,
  };

  // Only a pending collection order takes new orders: a processed, lastmile or
  // delivered one has been picked up already, and the order got into a pickup
  // already done (issues/303). An order already in one stays there unless its
  // point, route or day changes (the early return above).
  // v3 flat operators (`status_nin`) and query params (`_sort`) are not
  // understood by v5's db.query: they were passed through verbatim as column
  // names, so this threw "Unknown column 't0.status_nin' in 'where clause'" and
  // every collection order creation returned 500.
  const existingCollectionOrdersRaw = await strapi.db.query('api::order.order').findMany({
    where: {
      is_collection_order: true,
      owner: ownerId,
      contact: collectionPointId,
      route: route.id,
      status: 'pending',
    },
    // The filter below compares `collection_pickup_route` / `route` ids off
    // these rows. v3 returned them as FK columns; unpopulated in v5 they are
    // undefined, so the match never succeeded, no existing collection order was
    // ever reused and every order got its own -- "les comandes de recollida no
    // s'agrupen".
    populate: { collection_pickup_route: true, route: true },
    orderBy: { id: 'asc' },
  });

  const existingCollectionOrdersByDate = (existingCollectionOrdersRaw || []).filter((co) => {
    const candidatePickupDate = normalizeOrderDate(co.collection_pickup_date || co.estimated_delivery_date);
    const candidateRouteId = extractId(co.collection_pickup_route) || extractId(co.route);
    return candidatePickupDate === collectionPickupDate && candidateRouteId === groupingRouteId;
  });

  const existingCollectionOrders = [];
  const contaminatedCollectionOrders = [];

  for (const co of existingCollectionOrdersByDate) {
    const linkedOrders = await strapi.db
      .query('api::order.order')
      .findMany({ where: { collection_order: co.id, status: { $notIn: CLOSED_STATUSES } } });

    const hasMixedLinkedDates = (linkedOrders || []).some((linkedOrder) => {
      const linkedPickupDate = normalizeOrderDate(
        linkedOrder.collection_pickup_date || linkedOrder.estimated_delivery_date,
      );
      return linkedPickupDate !== collectionPickupDate;
    });

    if (hasMixedLinkedDates) {
      contaminatedCollectionOrders.push({
        id: co.id,
        linkedOrderIds: (linkedOrders || []).map((o) => o.id),
      });
    } else {
      existingCollectionOrders.push(co);
    }
  }

  let collectionOrder =
    existingCollectionOrders && existingCollectionOrders.length > 0 ? existingCollectionOrders[0] : null;

  // Collection-order pickup should be the route transfer warehouse when available
  const originalPickupId = extractId(orderData.pickup);
  const routeTransferPickupId = extractId(route.transfer_pickup);
  const collectionOrderPickupId = routeTransferPickupId || originalPickupId;

  // Check if transfer is needed for the collection order
  // If the collection order uses the original pickup (which might be "Recollida en Finca"),
  // we need to pass the collection_point so the transfer check can use it
  const collectionOrderData = {
    pickup: collectionOrderPickupId,
    collection_point: collectionOrderPickupId === originalPickupId ? orderData.collection_point : null,
  };

  const transferInfo = await checkTransferNeededForCollectionOrder(
    collectionOrderPickupId,
    route.id,
    collectionOrderData,
  );

  // Calculate transfer route if transfer is needed
  let transferRouteInfo = { transfer_route: null, transfer_route_date: null };
  if (transferInfo.transfer) {
    transferRouteInfo = await calculateTransferRoute(estimatedDeliveryDate);
  }

  if (collectionOrder) {
    // Update existing collection order
    const updateData = {
      transfer: transferInfo.transfer,
      contact_pickup_discount: collectionPointContact.pickup_discount || 0,
      _internal: true, // Prevent recursive processing
    };

    updateData.collection_point = null;
    updateData.collection_pickup_route = null;

    if (collectionOrderPickupId) {
      updateData.pickup = collectionOrderPickupId;
    }

    // Preserve auto-generated route/date values for existing collection orders.
    // Only backfill if any of these fields are missing.
    if (!extractId(collectionOrder.route)) {
      updateData.route = route.id;
    }
    if (!normalizeOrderDate(collectionOrder.collection_pickup_date)) {
      updateData.collection_pickup_date = collectionPickupDate;
    }
    if (!normalizeOrderDate(collectionOrder.estimated_delivery_date)) {
      updateData.estimated_delivery_date = estimatedDeliveryDate;
    }

    if (transferInfo.transfer) {
      updateData.transfer_pickup_origin = transferInfo.transfer_pickup_origin;
      updateData.transfer_pickup_destination = transferInfo.transfer_pickup_destination;
      updateData.transfer_route = transferRouteInfo.transfer_route;
      updateData.transfer_route_date = transferRouteInfo.transfer_route_date;
    } else {
      // Clear transfer route fields if no transfer is needed
      updateData.transfer_route = null;
      updateData.transfer_route_date = null;
    }

    // Copy delivery_type from original order if available
    if (orderData.delivery_type) {
      updateData.delivery_type = extractId(orderData.delivery_type);
    }

    // Add current order to collection_orders. `connect` adds one link and
    // keeps the rest: a plain array *replaces* the relation in v5, and
    // `collection_orders` is not populated on the row above, so the old
    // `[...current, id]` was `[id]` — each new order unlinked every order
    // already grouped, leaving only the last one picked up (24875 kept 24886
    // and lost 24874, 24876–24883).
    const orderIdToAdd = orderId || orderData.id;
    if (orderIdToAdd) {
      updateData.collection_orders = { connect: [orderIdToAdd] };
    }

    await strapi.db.query('api::order.order').update({ where: { id: collectionOrder.id }, data: updateData });

    // Ensure original order points to the reused collection order
    if (orderId && extractId(orderData.collection_order) !== collectionOrder.id) {
      await strapi.db
        .query('api::order.order')
        .update({ where: { id: orderId }, data: { collection_order: collectionOrder.id, _internal: true } });
    }

    // After updating, recalculate aggregated data
    await updateCollectionOrderAggregates(collectionOrder.id);
  } else {
    // Create new collection order
    const createData = {
      is_collection_order: true,
      owner: ownerId,
      contact: collectionPointId,
      contact_name: collectionPointContact.name,
      contact_trade_name: collectionPointContact.trade_name || collectionPointContact.name,
      contact_nif: collectionPointContact.nif,
      contact_address: collectionPointContact.address,
      contact_postcode: collectionPointContact.postcode,
      contact_city: collectionPointContact.city,
      contact_phone: collectionPointContact.phone,
      contact_legal_form: extractId(collectionPointContact.legal_form),
      contact_notes: collectionPointContact.notes,
      contact_time_slot_1_ini: collectionPointContact.time_slot_1_ini,
      contact_time_slot_1_end: collectionPointContact.time_slot_1_end,
      contact_time_slot_2_ini: collectionPointContact.time_slot_2_ini,
      contact_time_slot_2_end: collectionPointContact.time_slot_2_end,
      contact_pickup_discount: collectionPointContact.pickup_discount || 0,
      route: route.id,
      collection_pickup_route: null,
      collection_pickup_date: collectionPickupDate,
      estimated_delivery_date: estimatedDeliveryDate,
      pickup: collectionOrderPickupId,
      collection_point: null,
      status: 'pending',
      transfer: transferInfo.transfer,
      units: 0,
      kilograms: 0,
      refrigerated: false,
      _internal: true, // Prevent recursive processing
    };

    // Copy delivery_type from original order if available
    if (orderData.delivery_type) {
      createData.delivery_type = extractId(orderData.delivery_type);
    }

    if (transferInfo.transfer) {
      createData.transfer_pickup_origin = transferInfo.transfer_pickup_origin;
      createData.transfer_pickup_destination = transferInfo.transfer_pickup_destination;
      createData.transfer_route = transferRouteInfo.transfer_route;
      createData.transfer_route_date = transferRouteInfo.transfer_route_date;
    }

    // Add current order to collection_orders
    if (orderId) {
      createData.collection_orders = [orderId];
    }

    // v5 takes { data }, v3 took the values directly. Passing them bare left
    // event.params.data undefined, and beforeCreate died on `data.route_date`
    // -> "Cannot read properties of undefined" and a 500 on every collection
    // order.
    const newCollectionOrder = await strapi.db
      .query('api::order.order')
      .create({ data: createData });

    // Update the original order with the collection_order reference
    if (orderId && newCollectionOrder) {
      await strapi.db
        .query('api::order.order')
        .update({ where: { id: orderId }, data: { collection_order: newCollectionOrder.id, _internal: true } });

      // After creating, recalculate aggregated data
      await updateCollectionOrderAggregates(newCollectionOrder.id);
    }
  }
};

/**
 * Check if collection order should be auto-deposited
 */
const checkAndUpdateCollectionOrderStatus = async (collectionOrderId) => {
  // Get the collection order
  const collectionOrder = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id: collectionOrderId } });

  if (!collectionOrder || !collectionOrder.is_collection_order) {
    return;
  }

  // Only process if collection order is pending or deposited
  if (collectionOrder.status !== 'pending') {
    return;
  }

  // Get all related orders (exclude cancelled and invoiced orders)
  const relatedOrders = await strapi.db.query('api::order.order').findMany({
    where: { collection_order: collectionOrderId, status: { $notIn: CLOSED_STATUSES } },
  });

  if (!relatedOrders || relatedOrders.length === 0) {
    return;
  }
};

/**
 * The delivery type of a collection order (-R) that matches what it collects
 * (`refrigerated`: any of its orders is): its own when it matches, else the
 * newest of its orders' that does, else the first delivery type that does
 * (issues/292).
 */
const collectionDeliveryTypeId = async (collectionOrder, relatedOrders, refrigerated) => {
  const isCold = (type) => Boolean(type && type.refrigerated);
  const current = collectionOrder.delivery_type;
  if (current && typeof current === 'object' && isCold(current) === refrigerated) return current.id;
  const child = [...relatedOrders]
    .sort((a, b) => b.id - a.id)
    .find((o) => o.delivery_type && typeof o.delivery_type === 'object' && isCold(o.delivery_type) === refrigerated);
  if (child) return child.delivery_type.id;
  const types = await strapi.db
    .query('api::delivery-type.delivery-type')
    .findMany({ select: ['id', 'refrigerated'], orderBy: { id: 'asc' } });
  const type = (types || []).find((t) => isCold(t) === refrigerated);
  return type ? type.id : extractId(current);
};

/**
 * Update collection order with aggregated data from its collection_orders
 */
const updateCollectionOrderAggregates = async (collectionOrderId) => {
  // Get the collection order with its related orders.
  //
  // contact, route and delivery_type all have to be populated: `contact` is
  // dereferenced below to refresh the pickup discount (unpopulated it read as
  // undefined and the discount was rewritten to 0), and
  // findCollectionOrderRouteRate returns early on `!collectionOrder.route`
  // — which is why these collection orders ended up with price NULL.
  const collectionOrder = await strapi.db.query('api::order.order').findOne({
    where: { id: collectionOrderId },
    populate: { contact: true, route: true, delivery_type: true, emitted_invoice: { select: ['id'] } },
  });

  if (!collectionOrder) {
    return;
  }

  if (!collectionOrder.is_collection_order) {
    return;
  }

  // If the collection order is already cancelled or invoiced, skip aggregate updates
  // (it's already in its final state and shouldn't be modified further)
  if (collectionOrder.status === 'cancelled' || collectionOrder.status === 'invoiced') {
    return;
  }

  // Get the collection point contact to refresh discount
  const collectionPointId = extractId(collectionOrder.contact);
  let updatedPickupDiscount = 0;

  if (collectionPointId) {
    const collectionPointContact = await strapi.db
      .query('api::contact.contact')
      .findOne({ where: { id: collectionPointId } });
    if (collectionPointContact) {
      updatedPickupDiscount = collectionPointContact.pickup_discount || 0;
    }
  }

  // Get all related orders (exclude cancelled and invoiced orders from aggregation)
  const relatedOrders = await strapi.db.query('api::order.order').findMany({
    where: { collection_order: collectionOrderId, status: { $notIn: CLOSED_STATUSES } },
    populate: { delivery_type: { select: ['id', 'refrigerated'] } },
  });

  // If no related orders and status is pending, deposited, or processed, reset aggregates to 0
  // and cancel it -- only when no order left in it is active: an invoiced one
  // keeps it (the user's decision, 2026-10-19, issues/217)
  if (!relatedOrders || relatedOrders.length === 0) {
    const active = await strapi.db.query('api::order.order').findMany({
      where: { collection_order: collectionOrderId, status: { $ne: 'cancelled' } },
      select: ['id'],
    });
    if (active && active.length > 0) return;
    if (collectionOrder.status === 'pending' || collectionOrder.status === 'processed') {
      // v3 used a two-argument update signature; v5 takes a single { where, data }.
      await strapi.db.query('api::order.order').update({
        where: { id: collectionOrderId },
        data: {
          units: 0,
          kilograms: 0,
          price: 0,
          refrigerated: false,
          status: 'cancelled',
          contact_pickup_discount: updatedPickupDiscount,
          _internal: true,
        },
      });
    }
    return;
  }

  // Calculate aggregates
  let totalUnits = 0;
  let totalKilograms = 0;
  let isRefrigerated = false;
  let commentsArray = [];

  relatedOrders.forEach((order) => {
    totalUnits += order.units || 0;
    totalKilograms += parseFloat(order.kilograms || 0);
    if (order.refrigerated) {
      isRefrigerated = true;
    }
    // Collect comments from orders that have them
    // if (order.comments && order.comments.trim() !== '') {
    //   commentsArray.push(`#${order.id} ${order.comments}`);
    // }
  });

  // Concatenate comments with newlines
  // const concatenatedComments = commentsArray.join('\n');

  // The -R is priced at the rate of what it collects: refrigerated when any
  // of its orders is. Its delivery type was copied from the newest order
  // only, so a refrigerated collection got the normal rate and vice versa
  // (issues/292). One that is delivered or on an invoice keeps its type.
  let deliveryTypeId = extractId(collectionOrder.delivery_type);
  if (repriceable([collectionOrder]).length) {
    deliveryTypeId = await collectionDeliveryTypeId(collectionOrder, relatedOrders, isRefrigerated);
  }

  // Calculate route rate excluding "Pickup" rates
  const routeRate = await findCollectionOrderRouteRate({ ...collectionOrder, delivery_type: deliveryTypeId });

  // Update collection order with aggregates
  const updateData = {
    units: totalUnits,
    kilograms: totalKilograms,
    refrigerated: isRefrigerated,
    // comments: concatenatedComments,
    contact_pickup_discount: updatedPickupDiscount,
    _internal: true,
  };

  if (deliveryTypeId && deliveryTypeId !== extractId(collectionOrder.delivery_type)) {
    updateData.delivery_type = deliveryTypeId;
  }

  // Only update route_rate if one was found
  if (routeRate) {
    updateData.route_rate = routeRate.id;
    updateData.price = calculatePriceFromRouteRate(routeRate, totalKilograms, 0);
  }

  await strapi.db.query('api::order.order').update({ where: { id: collectionOrderId }, data: updateData });
};

const sameInstant = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/**
 * The farm pickup of a collection order (-R) is the pickup of the orders it
 * collects: when the driver marks it collected, moves it or undoes it, its
 * open orders follow, so they no longer wait for a «Recollir» of their own
 * (issues/267). An order with a pickup of its own (not the previous one of
 * the collection order) keeps it.
 */
const syncCollectionPickup = async (collectionOrderId, previousOrder) => {
  if (!previousOrder) return;
  const collectionOrder = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id: collectionOrderId }, populate: { pickup_user: true } });
  if (!collectionOrder || !collectionOrder.is_collection_order) return;
  const before = previousOrder.pickup_date || null;
  const now = collectionOrder.pickup_date || null;
  if (sameInstant(before, now)) return;
  const children = await strapi.db.query('api::order.order').findMany({
    where: { collection_order: collectionOrderId, status: { $notIn: CLOSED_STATUSES } },
  });
  for (const child of children || []) {
    if (child.pickup_date && !(before && sameInstant(child.pickup_date, before))) continue;
    if (!child.pickup_date && !now) continue;
    await strapi.db.query('api::order.order').update({
      where: { id: child.id },
      data: {
        pickup_date: now,
        pickup_user: now ? extractId(collectionOrder.pickup_user) : null,
        _internal: true,
      },
    });
  }
};

const removeMultideliveryDiscountFromOrders = async (orders) => {
  for await (const order of repriceable(orders)) {
    if (order.multidelivery_discount > 0) {
      await strapi
        .query('api::order.order')
        .update({ where: { id: order.id }, data: { multidelivery_discount: 0, _internal: true } });
    }
  }
};

const updateMultideliveryDiscountForOrders = async (orders, me, ownerFactor = 1) => {
  const discountToApply = ownerFactor * (me.orders_options?.multidelivery_discount || 0);

  for await (const order of repriceable(orders)) {
    if (order.multidelivery_discount !== discountToApply) {
      await strapi.db.query('api::order.order').update({
        where: { id: order.id },
        data: { multidelivery_discount: discountToApply, _internal: true },
      });
    }
  }
};

// --- ORDER HISTORY ---
// Who changed what on an order, and when, is recorded around the document
// action by services/change-log.js (issues/119), not here: these hooks also
// run for the lifecycles' own follow-up writes.

// --- INCIDENCES LOGIC ---
// Lives in a service: the order controller has to call it too, because v5
// validates relation payloads before lifecycles run. See order-incidences.js.
const { processIncidences } = require('../../services/order-incidences');

const processMultideliveryDiscountForCurrentOrder = async (orderId, data) => {
  // Skip if this is an internal update
  if (data._internal) {
    return;
  }

  // Skip if order is invoiced
  if (data.status === 'invoiced' || data.status === 'delivered') {
    return;
  }

  // Skip if no contact
  if (!data.contact) {
    return;
  }

  // orders_options is a component: a bare findOne() leaves it out, so the
  // discount read as unset and multidelivery was never recomputed in v5.
  const me = await getMe({ orders_options: true });
  if (!me?.orders_options?.multidelivery_discount) {
    return;
  }

  // Get owner information for discount factor
  const ownerId = extractId(data.owner);
  if (!ownerId) {
    return;
  }

  const owner = await strapi.db
    .query('plugin::users-permissions.user')
    .findOne({ where: { id: ownerId } });
  const ownerFactor = owner?.multidelivery_discount === false ? 0 : 1;

  // Normalize multidelivery_discount
  if (isNaN(data.multidelivery_discount)) {
    data.multidelivery_discount = 0;
  }

  // Process current order multidelivery
  const dataContactId = extractId(data.contact);
  const { multidelivery } = await checkMultidelivery(
    orderId,
    data.estimated_delivery_date,
    dataContactId,
    data.status,
  );

  if (multidelivery && !data.multidelivery_discount) {
    data.multidelivery_discount = ownerFactor * me.orders_options.multidelivery_discount || 0;
  } else if (!multidelivery && data.multidelivery_discount) {
    data.multidelivery_discount = 0;
  }
};

const processMultideliveryDiscountForOtherOrders = async (orderId, currentData, previousOrder = null) => {
  // Skip if this is an internal update
  if (currentData._internal) {
    return;
  }

  // Skip if order is invoiced
  if (currentData.status === 'invoiced' || currentData.status === 'delivered') {
    return;
  }

  // Skip if no contact
  if (!currentData.contact) {
    return;
  }

  // orders_options is a component: a bare findOne() leaves it out, so the
  // discount read as unset and multidelivery was never recomputed in v5.
  const me = await getMe({ orders_options: true });
  if (!me?.orders_options?.multidelivery_discount) {
    return;
  }

  // Get owner information for discount factor
  const ownerId = extractId(currentData.owner);
  if (!ownerId) {
    return;
  }

  const owner = await strapi.db
    .query('plugin::users-permissions.user')
    .findOne({ where: { id: ownerId } });

  const ownerFactor = owner?.multidelivery_discount === false ? 0 : 1;

  // Process current group - update other orders in the same group
  const contactId = extractId(currentData.contact);
  const { multidelivery, others } = await checkMultidelivery(
    orderId,
    currentData.estimated_delivery_date,
    contactId,
    currentData.status,
  );

  // Always update the current group if there are others and multidelivery conditions are met
  if (multidelivery && others.length > 0) {
    await updateMultideliveryDiscountForOrders(others, me, ownerFactor);
  } else if (!multidelivery && others.length > 0) {
    // If no longer multidelivery, remove discount from others in current group
    await removeMultideliveryDiscountFromOrders(others);
  }

  // For updates, handle changes in estimated_delivery_date, contact, or status
  if (previousOrder && orderId !== 0) {
    const dateChanged = previousOrder.estimated_delivery_date !== currentData.estimated_delivery_date;
    const contactChanged = extractId(previousOrder.contact) !== extractId(currentData.contact);
    const statusChanged = previousOrder.status !== currentData.status;

    // Special handling for status changes from/to cancelled
    const wasCancelled = previousOrder.status === 'cancelled';
    const isNowCancelled = currentData.status === 'cancelled';
    const statusChangeFromCancelled = wasCancelled && !isNowCancelled;
    const statusChangeToCancelled = !wasCancelled && isNowCancelled;

    // If key fields changed, check previous group and update their discounts
    if (dateChanged || contactChanged || statusChanged) {
      // Only check previous group if the order moved away from its previous group
      if (dateChanged || contactChanged) {
        // Check previous date/contact group
        const prevContactId = extractId(previousOrder.contact);
        const previousGroup = await checkMultidelivery(
          orderId,
          previousOrder.estimated_delivery_date,
          prevContactId,
          'active', // Use active status to check remaining orders
        );

        // Update previous group if they no longer qualify for multidelivery
        if (previousGroup.others.length > 0) {
          const stillHasMultidelivery = previousGroup.others.length > 1;

          if (!stillHasMultidelivery) {
            // Remove multidelivery discount from remaining orders
            await removeMultideliveryDiscountFromOrders(previousGroup.others);
          } else {
            // Previous group still has multidelivery, make sure they have the discount
            await updateMultideliveryDiscountForOrders(previousGroup.others, me, ownerFactor);
          }
        }
      } else if (statusChangeToCancelled) {
        // Order was cancelled, check if remaining orders in same group still qualify
        const currentContactId = extractId(currentData.contact);
        const remainingGroup = await checkMultidelivery(
          orderId,
          currentData.estimated_delivery_date,
          currentContactId,
          'active', // Check remaining active orders
        );

        if (remainingGroup.others.length > 0) {
          const stillHasMultidelivery = remainingGroup.others.length > 1;

          if (!stillHasMultidelivery) {
            // Remove multidelivery discount from remaining orders
            await removeMultideliveryDiscountFromOrders(remainingGroup.others);
          }
        }
      }
      // For statusChangeFromCancelled, the current group processing above already handles it
    }
  }
};

/**
 * An order that is and stays invoiced keeps the price it was invoiced with:
 * a price sent with it is dropped, not refused, since the order form and the
 * list's quick edit send the price with every save (issues/287). Taking the
 * order out of «Facturada» in the same save lets the price through.
 */
const keepInvoicedPrice = (data, previousOrder) => {
  if (!previousOrder || previousOrder.status !== 'invoiced') return;
  if (data.status !== undefined && data.status !== 'invoiced') return;
  if (!('price' in data)) return;
  const sent = data.price === null || data.price === undefined || data.price === '' ? null : Number(data.price);
  const kept = previousOrder.price === null || previousOrder.price === undefined ? null : Number(previousOrder.price);
  if (sent === kept) return;
  strapi.log.warn(`order ${previousOrder.id}: invoiced, price ${kept} kept (sent ${data.price})`);
  delete data.price;
};

/**
 * A collection order (-R) follows the orders it collects: its boxes, kilos,
 * refrigeration, delivery type, rate and price are their aggregate
 * (updateCollectionOrderAggregates), not edited by hand (the user's decision,
 * 2026-10-20, issues/292). A save from the app drops them; the generated
 * updates (`_internal`) never come through here.
 */
const COLLECTION_FOLLOWED_FIELDS = ['units', 'kilograms', 'refrigerated', 'delivery_type', 'route_rate', 'price'];
const keepCollectionAggregates = (data, previousOrder) => {
  if (!previousOrder || previousOrder.is_collection_order !== true) return;
  for (const field of COLLECTION_FOLLOWED_FIELDS) delete data[field];
};

/**
 * Read the documentation (https://strapi.io/documentation/developer-docs/latest/concepts/models.html#lifecycle-hooks)
 * to customize this model
 */

module.exports = {
  async beforeCreate(event) {
    const data = event.params.data;
    refusePastPickupDate(data);
    // Set route_date to current date if not provided
    if (!data.route_date) {
      data.route_date = new Date();
    }

    await enforceCollectionOrderFields(data);

    // Normalize contact_legal_form to prevent empty objects
    normalizeContactLegalForm(data);

    await setDeliveryTypeRefrigerated(data);

    if (data.status === 'lastmile') {
      data.last_mile = true;
    }

    // Calculate and set transfer route data for normal orders
    if (!data._internal && !data.is_collection_order) {
      const transferData = await calculateOrderTransferData(data);
      Object.assign(data, transferData);
    }

    await processMultideliveryDiscountForCurrentOrder(0, data);
    await processVolumeDiscountForCurrentOrder(0, data);

    await fillMissingPrice(data);
  },

  async beforeUpdate(event) {
    const params = { id: event.params.where && event.params.where.id };
    const data = event.params.data;
    if (data._internal) {
      return data;
    }
    // Get previous order data for comparison and store it for afterUpdate
    const previousOrder = await findWithCollectionRelations(params.id);

    // Store previous order data for afterUpdate
    event.state.previousOrderData = previousOrder;

    refusePastPickupDate(data, previousOrder);

    keepInvoicedPrice(data, previousOrder);
    keepCollectionAggregates(data, previousOrder);

    await enforceCollectionOrderFields(data, previousOrder);

    // a delivered order keeps the delivery date it already had: a bulk change
    // of an invoiced order back to Lliurada sends only the status and got
    // today's date (issues/304)
    if (data.status === 'delivered' && !data.delivery_date) {
      data.delivery_date =
        (previousOrder && previousOrder.delivery_date) ||
        data.estimated_delivery_date ||
        new Date();
    }
    // An order set back before delivery is not delivered any more: its
    // delivery date went on showing it as delivered (issues/266).
    if (PRE_DELIVERY_STATUSES.includes(data.status)) {
      data.delivery_date = null;
    }

    if (data.status === 'lastmile') {
      data.last_mile = true;
    }

    // Normalize contact_legal_form to prevent empty objects
    normalizeContactLegalForm(data);

    await setDeliveryTypeRefrigerated(data);

    // v3 stashed `data.incidences` here for afterUpdate to process. In v5 the
    // relation payload is validated before any lifecycle runs, so the write is
    // already rejected by the time this would fire — the order controller pulls
    // `incidences` off the request body instead. (The stash was also writing
    // `event.state.incidencesToProcess` while afterUpdate read
    // `data._incidencesToProcess`, so it could never have worked.)

    // Merge data with previous order data for complete context
    const mergedData = {
      ...previousOrder,
      ...data,
      // Ensure contact is properly handled if it's being updated
      contact: data.contact || previousOrder.contact,
      estimated_delivery_date: data.estimated_delivery_date || previousOrder.estimated_delivery_date,
      status: data.status || previousOrder.status,
      owner: data.owner || previousOrder.owner,
    };

    // Calculate and set transfer route data for normal orders if relevant fields changed
    // Skip if user has manually set the transfer route (manual_transfer_route flag).
    // The form sends pickup, route and date on every save, so "sent" is not
    // "changed": a save without changes turned old orders into transfers
    // dated in the past. A delivered, invoiced or cancelled order is past its
    // transfer and is never recomputed (issues/296).
    // The transfer fields sent with it are dropped when they differ from the
    // stored ones: a delivered, invoiced or cancelled order keeps its
    // transfer, and an open one changes it only by a recompute here or a
    // manual edit (the form recomputed it on load, issues/296).
    if (!data.is_collection_order && !previousOrder.is_collection_order) {
      const frozen = TRANSFER_FROZEN_STATUSES.includes(mergedData.status);
      const isManuallySet =
        data.manual_transfer_route === true || previousOrder.manual_transfer_route === true;
      if (frozen || (!isManuallySet && !transferFieldsChanged(data, previousOrder))) {
        await keepStoredTransfer(data, params.id);
      }
    }
    if (
      !data.is_collection_order &&
      !previousOrder.is_collection_order &&
      !TRANSFER_FROZEN_STATUSES.includes(mergedData.status)
    ) {
      const relevantFieldsChanged = transferFieldsChanged(data, previousOrder);

      const isManuallySet =
        data.manual_transfer_route === true || previousOrder.manual_transfer_route === true;

      // Only recalculate if fields changed AND not manually set by user
      if (relevantFieldsChanged && !isManuallySet) {
        const transferData = await calculateOrderTransferData(mergedData);
        Object.assign(data, transferData);
      }

      // If the manual flag is switched off, allow recalculation (the form
      // always sends it false)
      if (data.manual_transfer_route === false && previousOrder.manual_transfer_route === true) {
        const transferData = await calculateOrderTransferData(mergedData);
        Object.assign(data, transferData);
      }
    }

    // previousOrder is unpopulated: take the relations the discount grouping
    // needs from a populated read when the payload does not carry them.
    const previousRelations = await findWithDiscountRelations(params.id);
    event.state.previousRelations = previousRelations;
    for (const field of Object.keys(DISCOUNT_RELATIONS)) {
      if (mergedData[field] === undefined || mergedData[field] === null) {
        mergedData[field] = previousRelations ? previousRelations[field] : null;
      }
    }

    await processMultideliveryDiscountForCurrentOrder(params.id, mergedData);

    data.multidelivery_discount = mergedData.multidelivery_discount;
    await processVolumeDiscountForCurrentOrder(params.id, mergedData);
    data.volume_discount = mergedData.volume_discount;

    await fillMissingPrice(data, previousOrder);
  },
  async afterCreate(event) {
    const result = event.result;
    const data = event.state || {};
    // Skip if this is an internal update
    if (data._internal) {
      return;
    }

    // Process collection order if needed. Re-read rather than use `result`:
    // its relations are whatever the caller asked to populate (the order form
    // sends populate=*, a bare create has none and would never be grouped).
    const created = (await findWithCollectionRelations(result.id)) || result;
    await processCollectionOrder(result.id, created, null);

    // If this order was added to a collection order, check if it should be auto-deposited
    const updatedOrder = await findWithCollectionRelations(result.id);
    if (updatedOrder && updatedOrder.collection_order) {
      const collectionOrderId =
        typeof updatedOrder.collection_order === 'object'
          ? updatedOrder.collection_order.id
          : updatedOrder.collection_order;
      await checkAndUpdateCollectionOrderStatus(collectionOrderId);
    }

    // Process incidences if provided
    if (data._incidencesToProcess) {
      await processIncidences(result.id, data._incidencesToProcess, data._tracking_user);
    }

    // Process multidelivery discount for other orders after the current order is created
    const previousOrder = await findWithDiscountRelations(result.id);

    // Ensure transfer route is calculated for new orders that need transfer
    // This handles edge cases where beforeCreate didn't set it properly
    if (
      previousOrder &&
      previousOrder.transfer &&
      !previousOrder.is_collection_order &&
      (!previousOrder.transfer_route || !previousOrder.transfer_route_date)
    ) {
      const transferRouteInfo = await calculateTransferRoute(
        previousOrder.estimated_delivery_date,
        previousOrder.collection_pickup_date,
      );
      if (transferRouteInfo.transfer_route || transferRouteInfo.transfer_route_date) {
        await strapi.db.query('api::order.order').update({
          where: { id: result.id },
          data: {
            transfer_route: transferRouteInfo.transfer_route,
            transfer_route_date: transferRouteInfo.transfer_route_date,
            _internal: true,
          },
        });
      }
    }

    await processMultideliveryDiscountForOtherOrders(result.id, previousOrder);
    await processVolumeDiscountForOtherOrders(result.id, previousOrder);
  },

  async afterUpdate(event) {
    const result = event.result;
    const params = { id: event.params.where && event.params.where.id };
    const data = { ...(event.state || {}), ...(event.params.data || {}) };
    // Skip if this is an internal update
    if (data._internal) {
      return;
    }

    // Get the previous order data that was stored in beforeUpdate
    const previousOrder = event.state.previousOrderData || data._previousOrderData;

    // Get the current order state after the update
    const currentOrder = await findWithCollectionRelations(params.id);

    if (currentOrder) {
      // If this is a collection order itself being updated, recalculate its aggregates
      // but don't process it as a regular order (it should never create another collection order)
      if (currentOrder.is_collection_order) {
        await updateCollectionOrderAggregates(params.id);
        await syncCollectionPickup(params.id, previousOrder);
      } else {
        // Process collection order if needed (collection_point was added or changed)
        // This is only for regular orders that have a collection_point, not for collection orders themselves
        await processCollectionOrder(params.id, currentOrder, previousOrder);
      }

      // The collection order it is in now (read again: processCollectionOrder
      // above may have moved it to the -R of another day) recomputes its
      // aggregates, and so does the one it left: an order moved to another
      // day leaves its -R for the one of that day, and the old one is
      // cancelled when no active order is left in it (issues/292).
      const linkedNow = currentOrder.is_collection_order
        ? null
        : extractId(((await findWithCollectionRelations(params.id)) || {}).collection_order);
      if (linkedNow) {
        await updateCollectionOrderAggregates(linkedNow);
        // Check if collection order should be auto-deposited
        await checkAndUpdateCollectionOrderStatus(linkedNow);
      }

      // Check if collection_order was removed or changed
      const oldCollectionOrderId = previousOrder ? extractId(previousOrder.collection_order) : null;
      if (oldCollectionOrderId && oldCollectionOrderId !== linkedNow) {
        await updateCollectionOrderAggregates(oldCollectionOrderId);
        // Check if collection order should be auto-deposited
        await checkAndUpdateCollectionOrderStatus(oldCollectionOrderId);
      }
    }

    // Process incidences if provided
    if (data._incidencesToProcess) {
      await processIncidences(params.id, data._incidencesToProcess, data._tracking_user);
    }

    if (currentOrder) {
      // Ensure transfer route is calculated for orders that need transfer
      // This handles cases where orders were updated to need transfer but don't have the route yet
      // A delivered, invoiced or cancelled order is past its transfer: no
      // route nor date is filled in for it (issues/296).
      if (
        currentOrder.transfer &&
        !currentOrder.is_collection_order &&
        !TRANSFER_FROZEN_STATUSES.includes(currentOrder.status) &&
        (!currentOrder.transfer_route || !currentOrder.transfer_route_date)
      ) {
        const transferRouteInfo = await calculateTransferRoute(
          currentOrder.estimated_delivery_date,
          currentOrder.collection_pickup_date,
        );

        if (transferRouteInfo.transfer_route || transferRouteInfo.transfer_route_date) {
          await strapi.db.query('api::order.order').update({
            where: { id: params.id },
            data: {
              transfer_route: transferRouteInfo.transfer_route,
              transfer_route_date: transferRouteInfo.transfer_route_date,
              _internal: true,
            },
          });
        }
      }

      // Process multidelivery discount for other orders — both need the
      // contact / owner / route relations, on the order and on its previous
      // state, to find the old and the new date groups.
      const currentWithRelations = (await findWithDiscountRelations(params.id)) || currentOrder;
      const previousRelations = event.state.previousRelations;
      const previousWithRelations =
        previousOrder && previousRelations
          ? {
              ...previousOrder,
              contact: previousRelations.contact,
              owner: previousRelations.owner,
              route: previousRelations.route,
            }
          : previousOrder;
      await processMultideliveryDiscountForOtherOrders(params.id, currentWithRelations, previousWithRelations);
      await processVolumeDiscountForOtherOrders(params.id, currentWithRelations, previousWithRelations);
    }
  },

  async beforeDelete(event) {
    const params = event.params.where || {};
    // Store the order data before deletion to update collection order aggregates
    const order = await findWithCollectionRelations(params.id);
    if (order && order.collection_order) {
      // Store for afterDelete in event.state: params is the delete's `where`,
      // so a key set on it became a column filter and the delete failed.
      event.state.deletedOrderCollectionOrder = extractId(order.collection_order);
    }
  },

  async afterDelete(event) {
    // Update collection order aggregates if the deleted order was part of one
    if (event.state.deletedOrderCollectionOrder) {
      await updateCollectionOrderAggregates(event.state.deletedOrderCollectionOrder);
    }
  },
};

// For scripts/repair-unlinked-collection-orders.js. Non-enumerable: Strapi
// rejects any lifecycles key that is not a db action.
Object.defineProperty(module.exports, 'collectionOrderHelpers', {
  value: {
    updateCollectionOrderAggregates,
    checkTransferNeededForCollectionOrder,
    calculateTransferRoute,
    calculateEstimatedDeliveryDate,
  },
});
