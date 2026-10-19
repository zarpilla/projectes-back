'use strict';

/**
 * issues/227 (redesign review 5, 2026-10-19): order price edge cases.
 *
 * - An API update with only `kilograms` kept the old price (order 24772 kept
 *   5,00 € at 25 kg): fillMissingPrice now reprices when the kilos change and
 *   no price is sent.
 * - The invoice-line base (price − volume discount) went negative for an order
 *   without price, or cheaper than the discount, and counted −1,60 € in the KPIs
 *   and Facturar: floored at 0. The way the discounts combine (issues/057) is
 *   unchanged.
 * - The order form showed the price before the volume discount the lifecycle
 *   then stored (11,56 € before saving, 9,56 € after): check-multidelivery
 *   returns the volume discount the lifecycle computes, from the same function.
 * - The transfer of order 24946 was planned on 20/10 and its farm pickup was
 *   on 21/10: calculateTransferRoute ignored collection_pickup_date.
 */

const path = require('path');

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

describe('a kilogram-only update reprices the order (issues/227)', () => {
  let fillMissingPrice;
  beforeEach(() => {
    jest.resetModules();
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async (args) => {
            if (uid === 'api::order.order') return { id: 24772, route_rate: { id: 37 }, lines: [] };
            if (uid === 'api::route-rate.route-rate') return args.where.id === 37 ? RATE_V2 : null;
            return null;
          },
        }),
      },
    };
    ({ fillMissingPrice } = require('../src/api/order/services/route-price'));
  });
  afterEach(() => {
    delete global.strapi;
  });

  const stored = { id: 24772, price: 5, kilograms: 5, status: 'pending' };

  it('new kilos without a price: the price of the new kilos', async () => {
    const data = { kilograms: 25 };
    await fillMissingPrice(data, stored);
    expect(data.price).toBe(Math.round(((10.78 + 9.45) / 2) * 100) / 100);
  });

  it('a price sent with the kilos, or the same kilos, stay as they are', async () => {
    const withPrice = { kilograms: 25, price: 12 };
    await fillMissingPrice(withPrice, stored);
    expect(withPrice.price).toBe(12);

    const sameKilos = { kilograms: '5' };
    await fillMissingPrice(sameKilos, stored);
    expect(sameKilos.price).toBeUndefined();
  });

  it('closed orders keep their price', async () => {
    const data = { kilograms: 25 };
    await fillMissingPrice(data, { ...stored, status: 'invoiced' });
    expect(data.price).toBeUndefined();
  });
});

describe('the discounted base never goes below 0 (issues/227)', () => {
  const finalPrice = require('../src/api/order/services/final-price');

  it('an order without price or cheaper than the volume discount counts 0', () => {
    expect(finalPrice.orderInvoiceLine({ price: null, volume_discount: 2 }).base).toBe(0);
    expect(
      finalPrice.orderDiscountedPrice({ price: 0.4, volume_discount: 2, multidelivery_discount: 20 }),
    ).toBe(0);
  });

  it('other orders are unchanged', () => {
    expect(
      finalPrice.orderDiscountedPrice({
        price: 10,
        volume_discount: 1,
        multidelivery_discount: 10,
        contact_pickup_discount: 5,
      }),
    ).toBe(7.65);
  });
});

describe('check-multidelivery previews the volume discount the lifecycle stores (issues/227)', () => {
  let orders;
  let route;
  function load() {
    jest.resetModules();
    const ct = {
      uid: 'api::order.order',
      modelName: 'order',
      apiName: 'order',
      kind: 'collectionType',
      attributes: {},
    };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      log: { warn: () => {}, info: () => {} },
      documents: () => ({ findFirst: async () => ({ orders_options: { multidelivery_discount: 10 } }) }),
      db: {
        query: (uid) => ({
          findOne: async () => (uid === 'api::route.route' ? route : null),
          findMany: async () => (uid === 'api::order.order' ? orders : []),
        }),
      },
    };
    const ctrl = require(path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'))({
      strapi: global.strapi,
    });
    const { currentOrderVolumeDiscount } = require('../src/api/order/services/volume-discount');
    return { ctrl, currentOrderVolumeDiscount };
  }
  const check = (ctrl, body) => ctrl.checkMultidelivery({ request: { body } });

  beforeEach(() => {
    route = { id: 3, volume_discount_number_of_orders: 3, volume_discount_price: 2 };
    orders = [
      { id: 1, status: 'pending' },
      { id: 2, status: 'processed' },
      { id: 4, status: 'cancelled' },
    ];
  });
  afterEach(() => {
    delete global.strapi;
  });

  it("a new order that is the route's third that day gets the discount", async () => {
    const { ctrl, currentOrderVolumeDiscount } = load();
    const body = { date: '2026-10-21', contactId: 9, ownerId: 5, routeId: 3 };
    const res = await check(ctrl, body);
    expect(res.volume_discount).toBe(2);
    const stored = await currentOrderVolumeDiscount(0, {
      route: 3,
      owner: 5,
      estimated_delivery_date: '2026-10-21',
      status: 'pending',
    });
    expect(res.volume_discount).toBe(stored);
  });

  it('the second one does not; a delivered or invoiced order keeps its own', async () => {
    orders = orders.slice(1);
    const { ctrl } = load();
    expect(
      (await check(ctrl, { id: 7, date: '2026-10-21', contactId: 9, ownerId: 5, routeId: 3 }))
        .volume_discount,
    ).toBe(0);
    const delivered = await check(ctrl, {
      id: 7,
      date: '2026-10-21',
      contactId: 9,
      ownerId: 5,
      routeId: 3,
      status: 'delivered',
    });
    expect(delivered).not.toHaveProperty('volume_discount');
  });
});

describe('the transfer is not planned before the farm pickup (issues/227)', () => {
  let helpers;
  beforeEach(() => {
    jest.resetModules();
    global.strapi = {
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      db: {
        query: jest.fn((uid) => ({
          findOne: jest.fn(async () => null),
          findMany: jest.fn(async () =>
            uid === 'api::route.route'
              ? // 2026-10-20 is a Tuesday, 2026-10-22 a Thursday
                [{ id: 5, tuesday: true, thursday: true, is_transfer_route: true, active: true }]
              : [],
          ),
        })),
      },
    };
    helpers = require('../src/api/order/content-types/order/lifecycles').collectionOrderHelpers;
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('order 24946: pickup 21/10, delivery 23/10 → transfer 22/10, not 20/10', async () => {
    expect(await helpers.calculateTransferRoute('2026-10-23')).toEqual({
      transfer_route: 5,
      transfer_route_date: '2026-10-22',
    });
    const only = [{ id: 5, tuesday: true, is_transfer_route: true, active: true }];
    global.strapi.db.query = jest.fn((uid) => ({
      findMany: jest.fn(async () => (uid === 'api::route.route' ? only : [])),
    }));
    // a Tuesday-only transfer route: 20/10 is before the pickup, so none
    expect(await helpers.calculateTransferRoute('2026-10-23', '2026-10-21')).toEqual({
      transfer_route: null,
      transfer_route_date: null,
    });
    // without a pickup date, as before
    expect((await helpers.calculateTransferRoute('2026-10-23')).transfer_route_date).toBe('2026-10-20');
  });

  it('the pickup day itself is allowed', async () => {
    expect(await helpers.calculateTransferRoute('2026-10-23', new Date(2026, 9, 20))).toEqual({
      transfer_route: 5,
      transfer_route_date: '2026-10-22',
    });
    expect((await helpers.calculateTransferRoute('2026-10-21', '2026-10-20')).transfer_route_date).toBe(
      '2026-10-20',
    );
  });
});
