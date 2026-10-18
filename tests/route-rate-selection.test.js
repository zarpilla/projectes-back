'use strict';

/**
 * issues/151 (2026-10-18): route rate selection edge cases.
 * - The rate of a collection order (updateCollectionOrderAggregates) read the
 *   rates without populating them, so `routes` and `pickup` were absent, every
 *   rate looked generic and the first row of the table won, whatever its route.
 * - Only pickup id 1 (Magatzem Girona) counted as a warehouse: a rate of
 *   Magatzem Artés never applied. Warehouses are the pickups with `pickup` false.
 * - Several matching rates must resolve the same way whatever their order.
 * - /orders/table gave no collection point, so the quick edit of an order
 *   picked up at a farm through a collection point (24877) found no rate.
 */

const fs = require('fs');
const path = require('path');

const GIRONA = { id: 1, pickup: false };
const FINCA = { id: 2, pickup: true };
const ARTES = { id: 3, pickup: false };

describe('collection order route rate (issues/151)', () => {
  let findMany;
  beforeEach(() => {
    jest.resetModules();
    findMany = jest.fn();
    global.strapi = { db: { query: jest.fn(() => ({ findMany })) } };
  });
  afterEach(() => {
    delete global.strapi;
  });

  const load = () => require('../src/api/order/services/route-price');

  it('populates the routes, pickup and delivery type of the rates it compares', async () => {
    findMany.mockResolvedValue([]);
    await load().findCollectionOrderRouteRate({ route: { id: 17 }, delivery_type: 2 });
    const args = findMany.mock.calls[0][0];
    expect(Object.keys(args.populate).sort()).toEqual(['delivery_type', 'pickup', 'routes']);
  });

  it('takes the rate of the route over a rate of another route listed first', async () => {
    findMany.mockResolvedValue([
      { id: 37, routes: [{ id: 9 }], pickup: GIRONA, delivery_type: { id: 2 } },
      { id: 42, routes: [{ id: 17 }], pickup: GIRONA, delivery_type: { id: 2 } },
    ]);
    const rate = await load().findCollectionOrderRouteRate({ route: 17, delivery_type: { id: 2 } });
    expect(rate.id).toBe(42);
  });

  it('accepts the rates of any warehouse, not only id 1, and never a farm rate', () => {
    const { pickCollectionOrderRouteRate } = load();
    const rates = [
      { id: 5, routes: [{ id: 17 }], pickup: FINCA, delivery_type: null },
      { id: 6, routes: [{ id: 17 }], pickup: ARTES, delivery_type: null },
    ];
    expect(pickCollectionOrderRouteRate(rates, { routeId: 17 }).id).toBe(6);
  });

  it('resolves several matching rates deterministically, and tolerates a rate without routes', () => {
    const { pickCollectionOrderRouteRate } = load();
    const rates = [
      { id: 9, pickup: null, delivery_type: null },
      { id: 4, routes: [], pickup: null, delivery_type: null },
      { id: 7, routes: [], pickup: null, delivery_type: { id: 2 } },
    ];
    expect(pickCollectionOrderRouteRate(rates, { routeId: 17, deliveryTypeId: 2 }).id).toBe(7);
    expect(pickCollectionOrderRouteRate([...rates].reverse(), { routeId: 17, deliveryTypeId: 1 }).id).toBe(4);
    expect(pickCollectionOrderRouteRate([], { routeId: 17 })).toBeNull();
  });

  it('the lifecycle uses the shared selection', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'order', 'content-types', 'order', 'lifecycles.js'),
      'utf8',
    );
    expect(src).toContain('findCollectionOrderRouteRate(');
    expect(src).not.toMatch(/pickupId === 1/);
  });
});

describe('orders/table gives what the quick edit needs to pick a rate (issues/151)', () => {
  it('populates the collection point and the route rate', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'),
      'utf8',
    );
    const table = src.slice(src.indexOf('const TABLE_POPULATE'), src.indexOf('const DATE_RULES_EXEMPT'));
    expect(table).toMatch(/collection_point/);
    expect(table).toMatch(/route_rate/);
  });
});

describe('repairCollectionOrderRates (issues/151)', () => {
  let calls;
  beforeEach(() => {
    jest.resetModules();
    calls = [];
    const rates = [
      { id: 37, routes: [{ id: 9 }], pickup: GIRONA, delivery_type: { id: 1 }, ratev2: true, less10: 5, more10: 6, from10to20: 8, from20to30: 9, from30to40: 10 },
      { id: 42, routes: [{ id: 17 }], pickup: GIRONA, delivery_type: { id: 2 }, ratev2: true, less10: 4, more10: 10, from10to20: 12, from20to30: 13, from30to40: 14 },
    ];
    const orders = [
      // wrong rate: route 17 got rate 37
      { id: 1, kilograms: 20, price: 8, route: { id: 17 }, delivery_type: { id: 2 }, route_rate: { id: 37 } },
      // already right
      { id: 2, kilograms: 20, price: 8, route: { id: 9 }, delivery_type: { id: 1 }, route_rate: { id: 37 } },
      // has an invoice: left alone
      { id: 3, kilograms: 20, price: 8, route: { id: 17 }, delivery_type: { id: 2 }, route_rate: { id: 37 }, emitted_invoice: { id: 5 } },
    ];
    const table = (name) => {
      const chain = {
        where: (w) => {
          calls.push([name, 'where', w]);
          return chain;
        },
        update: async (d) => calls.push([name, 'update', d]),
        del: async () => calls.push([name, 'del']),
        insert: async (d) => calls.push([name, 'insert', d]),
      };
      return chain;
    };
    global.strapi = {
      log: { info: jest.fn() },
      db: {
        metadata: { get: () => ({ tableName: 'orders' }) },
        connection: table,
        query: (uid) => ({
          findMany: async (args) => {
            if (uid === 'api::order.order') {
              expect(args.where).toEqual({ is_collection_order: true, status: { $notIn: ['invoiced', 'cancelled'] } });
              return orders;
            }
            return rates;
          },
        }),
      },
    };
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('gives the open collection orders the rate of their route and its price', async () => {
    const { repairCollectionOrderRates } = require('../src/services/repair-collection-order-rates');
    const changed = await repairCollectionOrderRates();
    expect(changed).toEqual([{ id: 1, rate: [37, 42], price: [8, 12] }]);
    expect(calls).toEqual([
      ['orders', 'where', { id: 1 }],
      ['orders', 'update', { price: 12 }],
      ['orders_route_rate_lnk', 'where', { order_id: 1 }],
      ['orders_route_rate_lnk', 'del'],
      ['orders_route_rate_lnk', 'insert', { order_id: 1, route_rate_id: 42 }],
    ]);
  });
});
