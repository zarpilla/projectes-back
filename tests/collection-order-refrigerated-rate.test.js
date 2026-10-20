'use strict';

/**
 * issues/292 (review 9, 2026-10-20): a farm-collection order (-R) is flagged
 * refrigerated from its orders, but its rate was chosen by its own delivery
 * type, copied from the newest order only. Diligència -R 24894 collects only
 * 24893 (Refrigerada, 32 kg, rate 40, 16,43 €) and was refrigerated with
 * type Normal, rate 38, 11,99 €; re-saving 24893 did not fix it. 9 -R orders
 * were like that and 23 the other way round. The -R now takes the delivery
 * type of what it collects on every recompute.
 */

let ROWS;
const NORMAL = { id: 1, refrigerated: null };
const COLD = { id: 2, refrigerated: true };
const RATES = [
  { id: 38, routes: [], pickup: null, delivery_type: { id: 1 }, less15: 5, less30: 11.99, additional30: 0 },
  { id: 40, routes: [], pickup: null, delivery_type: { id: 2 }, less15: 8, less30: 16.43, additional30: 0 },
];

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
      return null;
    }),
    findMany: jest.fn(async ({ where } = {}) => {
      if (uid === 'api::route-rate.route-rate') return RATES;
      if (uid === 'api::delivery-type.delivery-type') return [NORMAL, COLD];
      if (uid === 'api::order.order') {
        return Object.values(ROWS).filter(
          (r) => r.collection_order && r.collection_order.id === where.collection_order && !where.status.$notIn.includes(r.status),
        );
      }
      return [];
    }),
    update: jest.fn(async ({ where, data }) => {
      const { _internal, ...rest } = data;
      ROWS[where.id] = { ...ROWS[where.id], ...rest };
      if (typeof rest.delivery_type === 'number') ROWS[where.id].delivery_type = [NORMAL, COLD].find((t) => t.id === rest.delivery_type);
      return ROWS[where.id];
    }),
  }));
  global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
}

const collection = (status, delivery_type, extra = {}) => ({
  id: 24894,
  is_collection_order: true,
  status,
  route: { id: 12 },
  contact: null,
  delivery_type,
  ...extra,
});
const child = (id, delivery_type, kilograms = 20) => ({
  id,
  status: 'pending',
  collection_order: { id: 24894 },
  delivery_type,
  refrigerated: delivery_type.refrigerated ? 1 : 0,
  kilograms,
  units: 1,
});

const recompute = async () => {
  jest.resetModules();
  stubStrapi();
  const { collectionOrderHelpers } = require('../src/api/order/content-types/order/lifecycles');
  await collectionOrderHelpers.updateCollectionOrderAggregates(24894);
  return ROWS[24894];
};

describe('the rate of a farm-collection order (issues/292)', () => {
  it('a -R of type Normal collecting a refrigerated order takes the refrigerated rate', async () => {
    ROWS = { 24894: collection('pending', NORMAL), 24893: child(24893, COLD) };
    const r = await recompute();
    expect(r.refrigerated).toBe(true);
    expect(r.delivery_type.id).toBe(2);
    expect(r.route_rate).toBe(40);
    expect(r.price).toBeCloseTo(16.43);
  });

  it('a -R of type Refrigerada collecting only normal orders takes the normal rate', async () => {
    ROWS = { 24894: collection('pending', COLD), 1: child(1, NORMAL), 2: child(2, NORMAL) };
    const r = await recompute();
    expect(r.refrigerated).toBe(false);
    expect(r.delivery_type.id).toBe(1);
    expect(r.route_rate).toBe(38);
  });

  it('one refrigerated order among normal ones makes it refrigerated, whatever the newest is', async () => {
    ROWS = { 24894: collection('pending', NORMAL), 1: child(1, COLD), 2: child(2, NORMAL) };
    const r = await recompute();
    expect(r.delivery_type.id).toBe(2);
    expect(r.route_rate).toBe(40);
  });

  it('a delivered -R, or one on an invoice, keeps its delivery type', async () => {
    ROWS = { 24894: collection('delivered', NORMAL), 24893: child(24893, COLD) };
    expect((await recompute()).delivery_type.id).toBe(1);
    ROWS = { 24894: collection('processed', NORMAL, { emitted_invoice: { id: 9 } }), 24893: child(24893, COLD) };
    expect((await recompute()).delivery_type.id).toBe(1);
  });
});
