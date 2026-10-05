'use strict';
/* global strapi */

/**
 * Route-rate pricing shared by the order lifecycles.
 *
 * The price of a regular order is computed in the browser (OrdersForm's
 * route_price) and posted with the order. Since the v5 cutover some
 * "Recollida en Finca" orders with a collection point reached the database
 * with price NULL: the form posted NaN, which JSON serialises as null. They
 * were then invoiced at 0.00. fillMissingPrice is the server-side net: an
 * order that is saved without a usable price gets it from its route rate,
 * with the same tiers the form uses.
 */
const { relationId } = require('../../../services/relation-input');

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

const hasUsablePrice = (value) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/**
 * Sets `data.price` when the order would otherwise be stored without one.
 *
 * @param {object} data           lifecycle payload (mutated)
 * @param {object} [previousOrder] the stored row, on update
 *
 * Leaves alone: internal writes, collection orders (their price is the
 * aggregate updateCollectionOrderAggregates computes), closed orders, and any
 * order whose price — sent now or already stored — is a real number.
 */
const fillMissingPrice = async (data, previousOrder = null) => {
  if (data._internal) return;
  const prev = previousOrder || {};
  if (data.is_collection_order || prev.is_collection_order) return;
  const status = data.status || prev.status;
  if (status === 'invoiced' || status === 'cancelled') return;

  const price = 'price' in data ? data.price : prev.price;
  if (hasUsablePrice(price)) return;

  const kilograms = Number(data.kilograms !== undefined ? data.kilograms : prev.kilograms);
  if (!Number.isFinite(kilograms) || kilograms <= 0) return;

  // An unpopulated relation is absent from the stored row, so read the rate
  // and the pickup lines of an existing order from the database.
  let stored = null;
  if (prev.id && (data.route_rate === undefined || data.lines === undefined)) {
    stored = await strapi.db.query('api::order.order').findOne({
      where: { id: prev.id },
      populate: { route_rate: true, lines: true },
    });
  }

  const rateRef = data.route_rate !== undefined ? data.route_rate : stored && stored.route_rate;
  const rateId = relationId(rateRef);
  if (rateId === undefined) return;
  const routeRate = await strapi.db.query('api::route-rate.route-rate').findOne({
    where: typeof rateId === 'number' ? { id: rateId } : { documentId: rateId },
  });
  if (!routeRate) return;

  const lines = data.lines !== undefined ? data.lines : stored && stored.lines;
  const pickupLines = Array.isArray(lines) ? lines.length : 0;

  data.price = Math.round(calculatePriceFromRouteRate(routeRate, kilograms, pickupLines) * 100) / 100;
};

module.exports = { calculatePriceFromRouteRate, fillMissingPrice };
