'use strict';

/**
 * Regression: since the v5 cutover, 15 "Recollida en Finca" orders with a
 * collection point were stored with price NULL (the form posted NaN, which
 * JSON serialises as null) and 8 of them were invoiced at 0.00.
 *
 * fillMissingPrice prices any regular order saved without a usable price from
 * its route rate, with the same tiers the order form uses.
 */

const { calculatePriceFromRouteRate, fillMissingPrice } = require('../src/api/order/services/route-price');

// Route rate 37 "Girona" as stored in production.
const RATE_V2 = {
  id: 37,
  ratev2: true,
  less10: 7.7,
  more10: 8.22,
  from10to20: 9.45,
  from20to30: 10.78,
  from30to40: 13.04,
  from40to50: 15.41,
  from50to60: 18.9,
  additional60: 0.29,
  pickup_point: null,
};

describe('calculatePriceFromRouteRate', () => {
  it('interpolates inside a ratev2 tier', () => {
    // 55 kg: halfway between from40to50 and from50to60
    expect(calculatePriceFromRouteRate(RATE_V2, 55, 0)).toBeCloseTo(17.155);
  });

  it('uses the flat tier under 10 kg and the per-kilo rate above 60', () => {
    expect(calculatePriceFromRouteRate(RATE_V2, 5, 0)).toBe(7.7);
    expect(calculatePriceFromRouteRate(RATE_V2, 70, 0)).toBeCloseTo(18.9 + 10 * 0.29);
  });

  it('prices the old rate structure', () => {
    const v1 = { ratev2: false, less15: 5, less30: 5.5, additional30: 0.18 };
    expect(calculatePriceFromRouteRate(v1, 10, 0)).toBe(5);
    expect(calculatePriceFromRouteRate(v1, 40, 0)).toBeCloseTo(5.5 + 10 * 0.18);
  });
});

describe('fillMissingPrice', () => {
  let stored;
  let queries;

  beforeEach(() => {
    queries = [];
    stored = { id: 24740, route_rate: { id: 37 }, lines: [] };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async (args) => {
            queries.push({ uid, args });
            if (uid === 'api::order.order') return stored;
            if (uid === 'api::route-rate.route-rate') return args.where.id === 37 ? RATE_V2 : null;
            return null;
          },
        }),
      },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('prices a new order posted with price null', async () => {
    const data = { price: null, kilograms: 55, route_rate: 37, status: 'pending' };
    await fillMissingPrice(data);
    expect(data.price).toBe(17.16);
  });

  it('prices an update of a stored order that has none, reading its rate from the db', async () => {
    const data = { status: 'delivered' };
    await fillMissingPrice(data, { id: 24740, price: null, kilograms: 55, status: 'pending' });
    expect(data.price).toBe(17.16);
    expect(queries[0]).toMatchObject({
      uid: 'api::order.order',
      args: { populate: { route_rate: true, lines: true } },
    });
  });

  it('accepts a v5 relation operation for the rate', async () => {
    const data = { price: null, kilograms: 5, route_rate: { set: [{ id: 37 }] } };
    await fillMissingPrice(data);
    expect(data.price).toBe(7.7);
  });

  it('keeps a real price, including 0', async () => {
    const data = { price: 12.5, kilograms: 55, route_rate: 37 };
    await fillMissingPrice(data);
    expect(data.price).toBe(12.5);

    const zero = { price: 0, kilograms: 55, route_rate: 37 };
    await fillMissingPrice(zero);
    expect(zero.price).toBe(0);

    const storedPrice = {};
    await fillMissingPrice(storedPrice, { id: 1, price: 9.76, kilograms: 5 });
    expect(storedPrice.price).toBeUndefined();
    expect(queries).toEqual([]);
  });

  it('leaves collection orders, closed orders and internal writes alone', async () => {
    for (const data of [
      { price: null, kilograms: 55, route_rate: 37, is_collection_order: true },
      { price: null, kilograms: 55, route_rate: 37, status: 'invoiced' },
      { price: null, kilograms: 55, route_rate: 37, status: 'cancelled' },
      { price: null, kilograms: 55, route_rate: 37, _internal: true },
    ]) {
      await fillMissingPrice(data);
      expect(data.price).toBeNull();
    }
    expect(queries).toEqual([]);
  });

  it('does nothing without a rate or kilos to price from', async () => {
    const noRate = { price: null, kilograms: 55 };
    await fillMissingPrice(noRate);
    expect(noRate.price).toBeNull();

    const noKilos = { price: null, route_rate: 37 };
    await fillMissingPrice(noKilos);
    expect(noKilos.price).toBeNull();
  });
});
