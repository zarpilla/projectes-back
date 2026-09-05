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

/**
 * Safely extract ID from a value that could be a number, string, or object with an id property
 * Returns null if the value is not a valid ID
 */
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
  // Otherwise, it's not a valid ID
  return null;
};
const normalizeOrderDate = (value) => {
  if (!value) return null;
  const textValue = String(value);
  return textValue.includes('T') ? textValue.split('T')[0] : textValue;
};

// --- VOLUME DISCOUNT LOGIC ---
const checkVolumeDiscount = async (id, date, routeId, ownerId, currentStatus) => {
  // Find all orders for the same route, date, and owner (excluding cancelled and this order)
  const ordersOfDateRouteOwner = await strapi.db.query('api::order.order').findMany({
    where: { estimated_delivery_date: moment(date).format('YYYY-MM-DD'), route: routeId, owner: ownerId },
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
      (currentStatus !== 'cancelled' ? 1 : 0) + others.filter((o) => o.status !== 'cancelled').length;
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

const updateVolumeDiscountForOrders = async (orders, discount) => {
  for await (const order of orders) {
    if (order.volume_discount !== discount) {
      await strapi
        .query('api::order.order')
        .update({ where: { id: order.id }, data: { volume_discount: discount } });
    }
  }
};

const processVolumeDiscountForCurrentOrder = async (orderId, data) => {
  if (data._internal) return;

  // Skip if order is invoiced or delivered
  if (data.status === 'invoiced' || data.status === 'delivered') {
    return;
  }

  // Only if route, owner, and date are present
  if (!data.route || !data.owner || !data.estimated_delivery_date) return;
  const routeId = data.route.id ? data.route.id : data.route;
  const ownerId = data.owner.id ? data.owner.id : data.owner;
  const { eligible, discount } = await checkVolumeDiscount(
    orderId,
    data.estimated_delivery_date,
    routeId,
    ownerId,
    data.status,
  );
  if (eligible) {
    data.volume_discount = discount;
  } else {
    data.volume_discount = 0;
  }
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
    for await (const order of others) {
      if (order.volume_discount > 0) {
        await strapi
          .query('api::order.order')
          .update({ where: { id: order.id }, data: { volume_discount: 0 } });
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
            for await (const order of prevGroup.others) {
              if (order.volume_discount > 0) {
                await strapi
                  .query('api::order.order')
                  .update({ where: { id: order.id }, data: { volume_discount: 0 } });
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

const checkMultidelivery = async (id, date, contactId, currentStatus) => {
  const ordersOfDateAndContact = await strapi.db.query('api::order.order').findMany({
    where: { estimated_delivery_date: moment(date).format('YYYY-MM-DD'), contact: contactId },
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
  if (data.delivery_type && data.delivery_type.id) {
    const deliveryTypes = await strapi.service('api::delivery-type.delivery-type').find();
    const deliveryType = deliveryTypes.find((d) => d.id === data.delivery_type.id);
    if (deliveryType && deliveryType.refrigerated) {
      data.refrigerated = 1;
    } else {
      data.refrigerated = 0;
    }
  } else if (data.delivery_type) {
    const deliveryTypes = await strapi.service('api::delivery-type.delivery-type').find();
    const deliveryType = deliveryTypes.find((d) => d.id === data.delivery_type);
    if (deliveryType && deliveryType.refrigerated) {
      data.refrigerated = 1;
    } else {
      data.refrigerated = 0;
    }
  }
};

/**
 * Normalize contact_legal_form to ensure it's never an empty object or invalid value
 */
const normalizeContactLegalForm = (data) => {
  // Check if contact_legal_form exists and is an object (including empty objects)
  if (data.contact_legal_form !== undefined && data.contact_legal_form !== null) {
    if (typeof data.contact_legal_form === 'object') {
      // It's an object - check if it has an id property
      if (data.contact_legal_form.id) {
        data.contact_legal_form = data.contact_legal_form.id;
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

  const route = await strapi.db.query('api::route.route').findOne({ where: { id: routeId } });
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
    .findMany({ where: { city: cityId } });
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
    .findMany({ where: { id_in: routeIds, active: true }, limit: 1 });

  return routes && routes.length > 0 ? routes[0] : null;
};

/**
 * Calculate estimated delivery date based on route
 */
const calculateEstimatedDeliveryDate = (route) => {
  if (!route) {
    return null;
  }

  const routeDayOfWeek = route.monday
    ? 1
    : route.tuesday
      ? 2
      : route.wednesday
        ? 3
        : route.thursday
          ? 4
          : route.friday
            ? 5
            : route.saturday
              ? 6
              : route.sunday
                ? 7
                : 0;

  if (routeDayOfWeek === 0) {
    return null;
  }

  // Find next occurrence of the route day
  let nextDay = moment();
  let found = false;
  let maxIterations = 7;
  let iterations = 0;

  while (!found && iterations < maxIterations) {
    nextDay = nextDay.add(1, 'day');
    if (routeDayOfWeek === nextDay.day()) {
      found = true;
    }
    iterations++;
  }

  return found ? nextDay.format('YYYY-MM-DD') : null;
};

/**
 * Check if transfer is needed for a collection order
 */
const checkTransferNeededForCollectionOrder = async (pickupId, routeId, orderData = null) => {
  if (!pickupId || !routeId) {
    return { transfer: false };
  }

  // Get pickup details
  const pickup = await strapi.db.query('api::pickup.pickup').findOne({ where: { id: pickupId } });
  if (!pickup) {
    return { transfer: false };
  }

  // Get route details
  const route = await strapi.db.query('api::route.route').findOne({ where: { id: routeId } });
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
 * Finds an active transfer route that operates on or before the estimated delivery date
 */
const calculateTransferRoute = async (estimatedDeliveryDate) => {
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

  // Helper function to get day of week from route
  const getRouteDayOfWeek = (route) => {
    if (route.monday) return 1;
    if (route.tuesday) return 2;
    if (route.wednesday) return 3;
    if (route.thursday) return 4;
    if (route.friday) return 5;
    if (route.saturday) return 6;
    if (route.sunday) return 0; // Sunday is 0 in moment.js
    return -1; // No day configured
  };

  // Start from the estimated delivery date and work backwards
  let currentDate = moment(estimatedDeliveryDate);
  let maxIterations = 14; // Check up to 2 weeks back
  let iterations = 0;

  while (iterations < maxIterations) {
    const currentDayOfWeek = currentDate.day();
    const isSameDay = currentDate.isSame(moment(estimatedDeliveryDate), 'day');

    // Check if any transfer route operates on this day
    for (const route of transferRoutes) {
      const routeDayOfWeek = getRouteDayOfWeek(route);

      if (routeDayOfWeek === currentDayOfWeek) {
        // Check date restriction based on is_transfer_route_date
        if (route.is_transfer_route_date === 'only_same_day') {
          // Only use this route if current date is same as estimated delivery date
          if (!isSameDay) {
            continue;
          }
        } else if (route.is_transfer_route_date === 'only_previous_days') {
          // Only use this route if current date is before estimated delivery date
          if (isSameDay) {
            continue;
          }
        }
        // If is_transfer_route_date is null/undefined, accept any day (existing behavior)

        return {
          transfer_route: route.id,
          transfer_route_date: currentDate.format('YYYY-MM-DD'),
        };
      }
    }

    // Move to previous day
    currentDate = currentDate.subtract(1, 'day');
    iterations++;
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
    const transferRouteInfo = await calculateTransferRoute(estimatedDeliveryDate);

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
    const dateChanged =
      normalizeOrderDate(previousOrderData.collection_pickup_date) !==
      normalizeOrderDate(orderData.collection_pickup_date);

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
    route = await strapi.db.query('api::route.route').findOne({ where: { id: routeId } });

    // Use date from frontend if provided
    if (orderData.collection_pickup_date) {
      collectionPickupDate = moment(orderData.collection_pickup_date).format('YYYY-MM-DD');
      estimatedDeliveryDate = collectionPickupDate;
    } else {
      // Fallback priority when collection_pickup_date is missing:
      // 1) main order collection pickup date (if present)
      // 2) main order estimated delivery date
      // 2) existing linked collection order date
      // 3) route next-day calculation (last resort)
      if (orderData.collection_pickup_date) {
        collectionPickupDate = moment(orderData.collection_pickup_date).format('YYYY-MM-DD');
      }

      if (orderData.estimated_delivery_date) {
        estimatedDeliveryDate = moment(orderData.estimated_delivery_date).format('YYYY-MM-DD');
      }

      if (!estimatedDeliveryDate) {
        const existingCollectionOrderId = extractId(orderData.collection_order);

        if (existingCollectionOrderId) {
          const existingCollectionOrder = await strapi.db
            .query('api::order.order')
            .findOne({ where: { id: existingCollectionOrderId } });

          if (existingCollectionOrder && existingCollectionOrder.collection_pickup_date) {
            collectionPickupDate = moment(existingCollectionOrder.collection_pickup_date).format(
              'YYYY-MM-DD',
            );
          }

          if (existingCollectionOrder && existingCollectionOrder.estimated_delivery_date) {
            estimatedDeliveryDate = moment(existingCollectionOrder.estimated_delivery_date).format(
              'YYYY-MM-DD',
            );
          }
        }
      }

      if (!estimatedDeliveryDate) {
        estimatedDeliveryDate = calculateEstimatedDeliveryDate(route);
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
        collectionPickupDate = moment(orderData.collection_pickup_date).format('YYYY-MM-DD');
        estimatedDeliveryDate = collectionPickupDate;
      } else if (orderData.estimated_delivery_date) {
        estimatedDeliveryDate = moment(orderData.estimated_delivery_date).format('YYYY-MM-DD');
        collectionPickupDate = estimatedDeliveryDate;
      } else {
        estimatedDeliveryDate = calculateEstimatedDeliveryDate(route);
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

  // Search for existing collection orders with any status EXCEPT cancelled and invoiced
  // Collection orders in delivered/lastmile/processed/pending status should all be reusable
  // Only cancelled and invoiced orders are truly "closed" and shouldn't be reused
  const existingCollectionOrdersRaw = await strapi.db.query('api::order.order').findMany({
    where: {
      is_collection_order: true,
      owner: ownerId,
      contact: collectionPointId,
      route: route.id,
      status_nin: ['cancelled', 'invoiced'],
      _sort: 'id:ASC',
    },
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
      .findMany({ where: { collection_order: co.id, status_nin: ['cancelled', 'invoiced'] } });

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

    // Add current order to collection_orders if not already there
    const currentCollectionOrders = collectionOrder.collection_orders || [];
    const orderIdToAdd = orderId || orderData.id;
    if (orderIdToAdd && !currentCollectionOrders.find((o) => (o.id || o) === orderIdToAdd)) {
      updateData.collection_orders = [...currentCollectionOrders.map((o) => o.id || o), orderIdToAdd];
    }

    await strapi.db.query('api::order.order').update({ where: { id: collectionOrder.id }, data: updateData });

    // Ensure original order points to the reused collection order
    if (orderId && extractId(orderData.collection_order) !== collectionOrder.id) {
      await strapi.db
        .query('api::order.order')
        .update({ where: { id: orderId }, data: { collection_order: collectionOrder.id } });
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

    const newCollectionOrder = await strapi.db.query('api::order.order').create(createData);

    // Update the original order with the collection_order reference
    if (orderId && newCollectionOrder) {
      await strapi.db
        .query('api::order.order')
        .update({ where: { id: orderId }, data: { collection_order: newCollectionOrder.id } });

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
    where: { collection_order: collectionOrderId, status_nin: ['cancelled', 'invoiced'] },
  });

  if (!relatedOrders || relatedOrders.length === 0) {
    return;
  }
};

/**
 * Update collection order with aggregated data from its collection_orders
 */
const updateCollectionOrderAggregates = async (collectionOrderId) => {
  // Get the collection order with its related orders
  const collectionOrder = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id: collectionOrderId } });

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
    where: { collection_order: collectionOrderId, status_nin: ['cancelled', 'invoiced'] },
  });

  // If no related orders and status is pending, deposited, or processed, reset aggregates to 0
  if (!relatedOrders || relatedOrders.length === 0) {
    if (collectionOrder.status === 'pending' || collectionOrder.status === 'processed') {
      await strapi.db.query('api::order.order').update(
        { id: collectionOrderId },
        {
          units: 0,
          kilograms: 0,
          price: 0,
          refrigerated: false,
          status: 'cancelled',
          contact_pickup_discount: updatedPickupDiscount,
        },
      );
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

  // Calculate route rate excluding "Pickup" rates
  const routeRate = await calculateCollectionOrderRouteRate(collectionOrder, totalKilograms);

  // Update collection order with aggregates
  const updateData = {
    units: totalUnits,
    kilograms: totalKilograms,
    refrigerated: isRefrigerated,
    // comments: concatenatedComments,
    contact_pickup_discount: updatedPickupDiscount,
  };

  // Only update route_rate if one was found
  if (routeRate) {
    updateData.route_rate = routeRate.id;
    updateData.price = calculatePriceFromRouteRate(routeRate, totalKilograms, 0);
  }

  await strapi.db.query('api::order.order').update({ where: { id: collectionOrderId }, data: updateData });
};

/**
 * Calculate route rate for collection order (excluding "Pickup" rates)
 */
const calculateCollectionOrderRouteRate = async (collectionOrder, kilograms) => {
  if (!collectionOrder.route) {
    return null;
  }

  const routeId =
    typeof collectionOrder.route === 'object' ? collectionOrder.route.id : collectionOrder.route;
  const deliveryTypeId = collectionOrder.delivery_type
    ? typeof collectionOrder.delivery_type === 'object'
      ? collectionOrder.delivery_type.id
      : collectionOrder.delivery_type
    : null;

  // Get all route rates
  let routeRates = await strapi.db.query('api::route-rate.route-rate').findMany({ where: {} });

  // Filter by route (rates that apply to this route or all routes)
  routeRates = routeRates.filter((r) => {
    if (!r.routes || r.routes.length === 0) return true;
    return r.routes.some((rt) => {
      const rtId = typeof rt === 'object' ? rt.id : rt;
      return rtId === routeId;
    });
  });

  // Exclude rates with pickup (we want rates without pickup or with pickup ID 1 "No Pickup")
  routeRates = routeRates.filter((r) => {
    if (!r.pickup) return true; // No pickup specified = applies to all
    const pickupId = typeof r.pickup === 'object' ? r.pickup.id : r.pickup;
    return pickupId === 1; // Only accept "No Pickup" rates
  });

  // Filter by delivery type
  if (deliveryTypeId) {
    routeRates = routeRates.filter((r) => {
      if (!r.delivery_type) return true;
      const dtId = typeof r.delivery_type === 'object' ? r.delivery_type.id : r.delivery_type;
      return dtId === deliveryTypeId;
    });
  }

  // Prefer rates specific to the route over general rates
  let specificRates = routeRates.filter((r) => r.routes && r.routes.length > 0);
  if (specificRates.length > 0) {
    return specificRates[0];
  }

  // Return first available rate
  return routeRates.length > 0 ? routeRates[0] : null;
};

/**
 * Calculate price from route rate
 */
const calculatePriceFromRouteRate = (routeRate, kilograms, pickupLines) => {
  let price = 0;

  if (!routeRate) {
    return price;
  }

  if (routeRate.ratev2 !== true) {
    // Old rate structure
    if (kilograms < 15) {
      price = routeRate.less15 || 0;
    } else if (kilograms < 30) {
      price = routeRate.less30 || 0;
    } else {
      price = (routeRate.less30 || 0) + (kilograms - 30) * (routeRate.additional30 || 0);
    }
  } else {
    // New rate structure (ratev2)
    if (kilograms < 10) {
      price = routeRate.less10 || 0;
    } else if (kilograms >= 10 && kilograms <= 20) {
      const t = (kilograms - 10) / 10;
      price = (routeRate.more10 || 0) + t * ((routeRate.from10to20 || 0) - (routeRate.more10 || 0));
    } else if (kilograms > 20 && kilograms <= 30) {
      const t = (kilograms - 20) / 10;
      price = (routeRate.from10to20 || 0) + t * ((routeRate.from20to30 || 0) - (routeRate.from10to20 || 0));
    } else if (kilograms > 30 && kilograms <= 40) {
      const t = (kilograms - 30) / 10;
      price = (routeRate.from20to30 || 0) + t * ((routeRate.from30to40 || 0) - (routeRate.from20to30 || 0));
    } else if (kilograms > 40 && kilograms <= 50) {
      const t = (kilograms - 40) / 10;
      price = (routeRate.from30to40 || 0) + t * ((routeRate.from40to50 || 0) - (routeRate.from30to40 || 0));
    } else if (kilograms > 50 && kilograms <= 60) {
      const t = (kilograms - 50) / 10;
      price = (routeRate.from40to50 || 0) + t * ((routeRate.from50to60 || 0) - (routeRate.from40to50 || 0));
    } else if (kilograms > 60) {
      price = (routeRate.from50to60 || 0) + (kilograms - 60) * (routeRate.additional60 || 0);
    }

    // Add pickup point charges if applicable (though for collection orders this should be 0)
    if (pickupLines > 0 && routeRate.pickup_point) {
      price += pickupLines * routeRate.pickup_point;
    }
  }

  return price;
};

const updateMultideliveryDiscountForOrders = async (orders, me, ownerFactor = 1) => {
  const discountToApply = ownerFactor * (me.orders_options?.multidelivery_discount || 0);

  for await (const order of orders) {
    if (order.multidelivery_discount !== discountToApply) {
      await strapi.db.query('api::order.order').update({
        where: { id: order.id },
        data: { multidelivery_discount: discountToApply },
      });
    }
  }
};

// --- ORDER TRACKING LOGIC ---
const createOrderTracking = async (orderId, status, user) => {
  try {
    const trackingData = {
      order_id: orderId,
      order_status: status,
    };

    // Determine if it's a user or admin user based on user object
    if (user) {
      // Check if it's an admin user by looking for roles array with content
      if (user.roles && Array.isArray(user.roles) && user.roles.length > 0) {
        // Admin user (has roles array with content)
        trackingData.admin_user = user.id;
      } else {
        // Regular user (users-permissions)
        trackingData.users_permissions_user = user.id;
      }
    }

    await strapi.db.query('api::orders-tracking.orders-tracking').create(trackingData);
  } catch (error) {
    // Log error but don't fail the order operation
    console.error('Error creating order tracking:', error);
  }
};

// --- INCIDENCES LOGIC ---
const processIncidences = async (orderId, incidences, trackingUser) => {
  try {
    // Get existing incidences for this order
    const existingIncidences = await strapi.db
      .query('api::incidence.incidence')
      .findMany({ where: { order: orderId } });

    // Create a map of existing incidences by ID for quick lookup
    const existingMap = new Map(existingIncidences.map((inc) => [inc.id, inc]));
    const processedIds = new Set();

    // Process each incidence from the form
    for (const incidence of incidences) {
      if (incidence.id) {
        // Update existing incidence
        processedIds.add(incidence.id);
        const existing = existingMap.get(incidence.id);

        if (existing) {
          const updateData = {
            description: incidence.description,
            state: incidence.state,
          };

          // If changing to closed state and not already closed, set closed_date and closed_user
          if (incidence.state === 'closed' && existing.state !== 'closed') {
            updateData.closed_date = new Date();
            if (trackingUser) {
              updateData.closed_user = trackingUser.id;
            }
          }

          await strapi.db
            .query('api::incidence.incidence')
            .update({ where: { id: incidence.id }, data: updateData });
        }
      } else {
        // Create new incidence
        const createData = {
          order: orderId,
          description: incidence.description,
          state: incidence.state || 'open',
        };

        if (trackingUser) {
          createData.created_user = trackingUser.id;
        }

        // If creating as closed, set closed_date and closed_user
        if (createData.state === 'closed') {
          createData.closed_date = new Date();
          if (trackingUser) {
            createData.closed_user = trackingUser.id;
          }
        }

        const newIncidence = await strapi.db.query('api::incidence.incidence').create(createData);
        processedIds.add(newIncidence.id);
      }
    }

    // Note: We're not deleting incidences that are not in the list
    // If you want to delete removed incidences, uncomment the code below:
    /*
    // Delete incidences that were removed from the list
    for (const existing of existingIncidences) {
      if (!processedIds.has(existing.id)) {
        await strapi.db.query('api::incidence.incidence').delete({ id: existing.id });
      }
    }
    */
  } catch (error) {
    console.error('Error processing incidences:', error);
    throw error;
  }
};

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

  const me = await strapi.db.query('api::me.me').findOne();
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

  const me = await strapi.db.query('api::me.me').findOne();
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
    for await (const order of others) {
      if (order.multidelivery_discount > 0) {
        await strapi
          .query('api::order.order')
          .update({ where: { id: order.id }, data: { multidelivery_discount: 0 } });
      }
    }
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
            for await (const order of previousGroup.others) {
              if (order.multidelivery_discount > 0) {
                await strapi
                  .query('api::order.order')
                  .update({ where: { id: order.id }, data: { multidelivery_discount: 0 } });
              }
            }
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
            for await (const order of remainingGroup.others) {
              if (order.multidelivery_discount > 0) {
                await strapi
                  .query('api::order.order')
                  .update({ where: { id: order.id }, data: { multidelivery_discount: 0 } });
              }
            }
          }
        }
      }
      // For statusChangeFromCancelled, the current group processing above already handles it
    }
  }
};

/**
 * Read the documentation (https://strapi.io/documentation/developer-docs/latest/concepts/models.html#lifecycle-hooks)
 * to customize this model
 */

module.exports = {
  async beforeCreate(event) {
    const data = event.data;
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
  },

  async beforeUpdate(event) {
    const params = { id: event.params.where && event.params.where.id };
    const data = event.data;
    if (data._internal) {
      return data;
    }
    // Get previous order data for comparison and store it for afterUpdate
    const previousOrder = await strapi.db.query('api::order.order').findOne({ where: { id: params.id } });

    // Store previous order data for afterUpdate
    event.state.previousOrderData = previousOrder;

    await enforceCollectionOrderFields(data, previousOrder);

    if (data.status === 'delivered' && !data.delivery_date) {
      data.delivery_date = data.estimated_delivery_date ? data.estimated_delivery_date : new Date();
    }

    if (data.status === 'lastmile') {
      data.last_mile = true;
    }

    // Normalize contact_legal_form to prevent empty objects
    normalizeContactLegalForm(data);

    await setDeliveryTypeRefrigerated(data);

    // Handle incidences if provided
    if (data.incidences && Array.isArray(data.incidences)) {
      // Store incidences data temporarily (will be processed in afterUpdate)
      event.state.incidencesToProcess = data.incidences;
      delete data.incidences; // Remove from data to avoid Strapi trying to process it
    }

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
    // Skip if user has manually set the transfer route (manual_transfer_route flag)
    if (!data.is_collection_order && !previousOrder.is_collection_order) {
      const relevantFieldsChanged =
        data.pickup !== undefined || data.route !== undefined || data.estimated_delivery_date !== undefined;

      const isManuallySet =
        data.manual_transfer_route === true || previousOrder.manual_transfer_route === true;

      // Only recalculate if fields changed AND not manually set by user
      if (relevantFieldsChanged && !isManuallySet) {
        const transferData = await calculateOrderTransferData(mergedData);
        Object.assign(data, transferData);
      }

      // If manual flag is explicitly set to false, allow recalculation
      if (data.manual_transfer_route === false) {
        const transferData = await calculateOrderTransferData(mergedData);
        Object.assign(data, transferData);
      }
    }

    await processMultideliveryDiscountForCurrentOrder(params.id, mergedData);

    data.multidelivery_discount = mergedData.multidelivery_discount;
    await processVolumeDiscountForCurrentOrder(params.id, mergedData);
    data.volume_discount = mergedData.volume_discount;
  },
  async afterCreate(event) {
    const result = event.result;
    const data = event.state || {};
    // Skip if this is an internal update
    if (data._internal) {
      return;
    }

    // Process collection order if needed
    await processCollectionOrder(result.id, result, null);

    // If this order was added to a collection order, check if it should be auto-deposited
    const updatedOrder = await strapi.db.query('api::order.order').findOne({ where: { id: result.id } });
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

    // Get user from data or try to get from created_by field
    let trackingUser = data._tracking_user;

    if (!trackingUser && result.created_by) {
      // Get the admin user who created the order
      trackingUser = await strapi.db.query('admin::user').findOne({ where: { id: result.created_by } }); // eslint-disable-line no-useless-assignment
    }

    // Create tracking entry for order creation
    // await createOrderTracking(result.id, result.status, trackingUser);

    // Process multidelivery discount for other orders after the current order is created
    const previousOrder = await strapi.db.query('api::order.order').findOne({ where: { id: result.id } });

    // Ensure transfer route is calculated for new orders that need transfer
    // This handles edge cases where beforeCreate didn't set it properly
    if (
      previousOrder &&
      previousOrder.transfer &&
      !previousOrder.is_collection_order &&
      (!previousOrder.transfer_route || !previousOrder.transfer_route_date)
    ) {
      const transferRouteInfo = await calculateTransferRoute(previousOrder.estimated_delivery_date);
      if (transferRouteInfo.transfer_route || transferRouteInfo.transfer_route_date) {
        await strapi.db.query('api::order.order').update({
          where: { id: result.id },
          data: {
            transfer_route: transferRouteInfo.transfer_route,
            transfer_route_date: transferRouteInfo.transfer_route_date,
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
    const currentOrder = await strapi.db.query('api::order.order').findOne({ where: { id: params.id } });

    if (currentOrder) {
      // If this is a collection order itself being updated, recalculate its aggregates
      // but don't process it as a regular order (it should never create another collection order)
      if (currentOrder.is_collection_order) {
        await updateCollectionOrderAggregates(params.id);
      } else {
        // Process collection order if needed (collection_point was added or changed)
        // This is only for regular orders that have a collection_point, not for collection orders themselves
        await processCollectionOrder(params.id, currentOrder, previousOrder);
      }

      // If this order has a collection_order, update its aggregates
      if (currentOrder.collection_order) {
        const collectionOrderId =
          typeof currentOrder.collection_order === 'object'
            ? currentOrder.collection_order.id
            : currentOrder.collection_order;
        await updateCollectionOrderAggregates(collectionOrderId);
        // Check if collection order should be auto-deposited
        await checkAndUpdateCollectionOrderStatus(collectionOrderId);
      }

      // Check if collection_order was removed
      if (previousOrder && previousOrder.collection_order && !currentOrder.collection_order) {
        const oldCollectionOrderId =
          typeof previousOrder.collection_order === 'object'
            ? previousOrder.collection_order.id
            : previousOrder.collection_order;
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
      // Get user from data or try to get from updated_by field
      let trackingUser = data._tracking_user;

      if (!trackingUser && currentOrder.updated_by) {
        // Get the admin user who made the update
        trackingUser = await strapi.db // eslint-disable-line no-useless-assignment
          .query('admin::user')
          .findOne({ where: { id: currentOrder.updated_by } });
      }

      // Create tracking entry for every update
      // await createOrderTracking(currentOrder.id, currentOrder.status, trackingUser);

      // Ensure transfer route is calculated for orders that need transfer
      // This handles cases where orders were updated to need transfer but don't have the route yet
      if (
        currentOrder.transfer &&
        !currentOrder.is_collection_order &&
        (!currentOrder.transfer_route || !currentOrder.transfer_route_date)
      ) {
        const transferRouteInfo = await calculateTransferRoute(currentOrder.estimated_delivery_date);

        if (transferRouteInfo.transfer_route || transferRouteInfo.transfer_route_date) {
          await strapi.db.query('api::order.order').update({
            where: { id: params.id },
            data: {
              transfer_route: transferRouteInfo.transfer_route,
              transfer_route_date: transferRouteInfo.transfer_route_date,
            },
          });
        }
      }

      // Process multidelivery discount for other orders
      await processMultideliveryDiscountForOtherOrders(params.id, currentOrder, previousOrder);
      await processVolumeDiscountForOtherOrders(params.id, currentOrder, previousOrder);
    }
  },

  async beforeDelete(event) {
    const params = event.params.where || {};
    // Store the order data before deletion to update collection order aggregates
    const order = await strapi.db.query('api::order.order').findOne({ where: { id: params.id } });
    if (order && order.collection_order) {
      // Store for afterDelete
      params._deletedOrderCollectionOrder =
        typeof order.collection_order === 'object' ? order.collection_order.id : order.collection_order;
    }
  },

  async afterDelete(event) {
    const result = event.result;
    const params = event.params.where || {};
    // Update collection order aggregates if the deleted order was part of one
    if (params._deletedOrderCollectionOrder) {
      await updateCollectionOrderAggregates(params._deletedOrderCollectionOrder);
    }
  },
};
