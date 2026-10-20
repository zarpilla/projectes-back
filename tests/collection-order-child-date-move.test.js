'use strict';

/**
 * issues/292 (the user's decision, 2026-10-20): a farm-collection order (-R)
 * is not edited by hand, it follows the orders it collects. When the office
 * changes the date of one of them, the order leaves its -R for the -R of the
 * new day (found, or created as when an order is created), and the old one
 * recomputes its totals (cancelled when no active order is left in it).
 *
 * The pickup day of an order is its `collection_pickup_date`, or its
 * expected delivery date when it has none (277 Diligència orders): moving the
 * delivery date of one of those left it in the -R of the old day.
 */

let ROWS;

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key] && typeof row[key] === 'object' ? row[key].id : row[key];
    if (cond && typeof cond === 'object') {
      if ('$notIn' in cond) return !cond.$notIn.includes(value);
      if ('$in' in cond) return cond.$in.includes(value);
      if ('$ne' in cond) return value !== cond.$ne;
      if ('id' in cond) return value === cond.id;
      return true;
    }
    return value === cond;
  });

// relations are stored as { id } like a populated read
const asRelation = (key, value) =>
  ['collection_order', 'route', 'owner', 'contact', 'collection_pickup_route', 'collection_point'].includes(key) &&
  typeof value === 'number'
    ? { id: value }
    : value;

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
      if (uid === 'api::contact.contact') return { id: where.id, name: 'Finca', pickup_discount: 0 };
      if (uid === 'api::route.route') return { id: where.id, tuesday: true, active: true };
      return null;
    }),
    findMany: jest.fn(async ({ where } = {}) =>
      uid === 'api::order.order' ? Object.values(ROWS).filter((r) => matches(r, where)) : [],
    ),
    update: jest.fn(async ({ where, data }) => {
      if (uid !== 'api::order.order') return null;
      const { _internal, collection_orders, ...rest } = data;
      for (const [k, v] of Object.entries(rest)) rest[k] = asRelation(k, v);
      ROWS[where.id] = { ...ROWS[where.id], ...rest };
      return ROWS[where.id];
    }),
    count: jest.fn(async () => 0),
    create: jest.fn(async ({ data }) => {
      const id = Math.max(...Object.keys(ROWS).map(Number)) + 1;
      const { collection_orders, ...rest } = data;
      for (const [k, v] of Object.entries(rest)) rest[k] = asRelation(k, v);
      ROWS[id] = { id, ...rest };
      for (const childId of collection_orders || []) ROWS[childId].collection_order = { id };
      return ROWS[id];
    }),
  }));
  global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
}

const child = (id, extra = {}) => ({
  id,
  status: 'processed',
  owner: { id: 100 },
  collection_pickup_route: { id: 3 },
  collection_point: { id: 30 },
  collection_order: { id: 10 },
  collection_pickup_date: '2026-10-06',
  estimated_delivery_date: '2026-10-07',
  kilograms: 10,
  units: 1,
  ...extra,
});
const collection = (id, day, extra = {}) => ({
  id,
  is_collection_order: true,
  status: 'pending',
  owner: { id: 100 },
  contact: { id: 30 },
  route: { id: 3 },
  collection_pickup_date: day,
  estimated_delivery_date: day,
  kilograms: 20,
  units: 2,
  ...extra,
});

/** Saves order 1 with `data` the way the update hooks see it. */
async function saveOrderOne(data) {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
  const lifecycles = require('../src/api/order/content-types/order/lifecycles');
  const event = { params: { where: { id: 1 }, data: { ...data } }, state: {} };
  await lifecycles.beforeUpdate(event);
  const { _tracking_user, ...stored } = event.params.data;
  ROWS[1] = { ...ROWS[1], ...stored };
  await lifecycles.afterUpdate(event);
}

const collectionOf = (id) => ROWS[id].collection_order && ROWS[id].collection_order.id;

// the scenario's dates are in October 2026: run it on 1 October, so the 302
// check on past pickup dates (issues/302) doesn't refuse the moves
afterEach(() => jest.useRealTimers());

describe('changing the date of an order collected by a -R (issues/292)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T08:00:00Z'));
    ROWS = {
      1: child(1),
      2: child(2, { kilograms: 4 }),
      10: collection(10, '2026-10-06', { kilograms: 14 }),
    };
  });

  it('moves it to a new -R of the new day and recomputes the old one', async () => {
    await saveOrderOne({ collection_pickup_date: '2026-10-13' });
    const moved = collectionOf(1);
    expect(moved).not.toBe(10);
    expect(ROWS[moved]).toMatchObject({ is_collection_order: true, status: 'pending', collection_pickup_date: '2026-10-13', kilograms: 10 });
    expect(ROWS[10]).toMatchObject({ status: 'pending', kilograms: 4, units: 1 });
  });

  it('joins the -R that already exists for the new day', async () => {
    ROWS[20] = collection(20, '2026-10-13', { kilograms: 0, units: 0 });
    ROWS[3] = child(3, { collection_order: { id: 20 }, collection_pickup_date: '2026-10-13', kilograms: 6 });
    await saveOrderOne({ collection_pickup_date: '2026-10-13' });
    expect(collectionOf(1)).toBe(20);
    expect(ROWS[20]).toMatchObject({ kilograms: 16, units: 2 });
    expect(ROWS[10]).toMatchObject({ kilograms: 4 });
  });

  it('cancels the old -R when it was its only order', async () => {
    delete ROWS[2];
    await saveOrderOne({ collection_pickup_date: '2026-10-13' });
    expect(collectionOf(1)).not.toBe(10);
    expect(ROWS[10]).toMatchObject({ status: 'cancelled', kilograms: 0 });
  });

  it('an order without a pickup date moves with its delivery date', async () => {
    ROWS[1] = child(1, { collection_pickup_date: null, estimated_delivery_date: '2026-10-06' });
    ROWS[2] = child(2, { collection_pickup_date: null, estimated_delivery_date: '2026-10-06', kilograms: 4 });
    await saveOrderOne({ estimated_delivery_date: '2026-10-13' });
    const moved = collectionOf(1);
    expect(moved).not.toBe(10);
    expect(ROWS[moved]).toMatchObject({ estimated_delivery_date: '2026-10-13', kilograms: 10 });
    expect(ROWS[10]).toMatchObject({ kilograms: 4 });
  });

  it('a save without a date change keeps it in its -R', async () => {
    await saveOrderOne({ collection_pickup_date: '2026-10-06', kilograms: 12 });
    expect(collectionOf(1)).toBe(10);
    expect(Object.values(ROWS).filter((r) => r.is_collection_order)).toHaveLength(1);
    expect(ROWS[10]).toMatchObject({ kilograms: 16 });
  });
});

describe('a -R is not edited by hand (issues/292)', () => {
  it('a save from the app keeps what follows its orders and lets the rest through', async () => {
    ROWS = {
      10: collection(10, '2026-10-06', { kilograms: 14, units: 2, price: 8, delivery_type: { id: 2 }, refrigerated: true }),
      1: child(1, { kilograms: 14, units: 2 }),
    };
    jest.resetModules();
    stubStrapi();
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
    const lifecycles = require('../src/api/order/content-types/order/lifecycles');
    const data = { kilograms: 99, units: 9, price: 1, delivery_type: 1, refrigerated: false, route_rate: 38, comments: 'Truqueu abans' };
    const event = { params: { where: { id: 10 }, data }, state: {} };
    await lifecycles.beforeUpdate(event);
    for (const field of ['kilograms', 'units', 'price', 'delivery_type', 'refrigerated', 'route_rate']) {
      expect(event.params.data).not.toHaveProperty(field);
    }
    expect(event.params.data.comments).toBe('Truqueu abans');
  });

  it('an order it collects is still edited', async () => {
    ROWS = { 1: child(1), 10: collection(10, '2026-10-06') };
    jest.resetModules();
    stubStrapi();
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
    const lifecycles = require('../src/api/order/content-types/order/lifecycles');
    const event = { params: { where: { id: 1 }, data: { kilograms: 12, price: 9 } }, state: {} };
    await lifecycles.beforeUpdate(event);
    expect(event.params.data).toMatchObject({ kilograms: 12, price: 9 });
  });
});

// issues/303 (the user's decision, 2026-10-20): a -R that is processed, in
// last mile or delivered has been picked up already. Any -R not cancelled or
// invoiced took new orders, so an order could land in a pickup already done;
// now only a pending -R takes them, and a new one is created otherwise.
describe('a -R past pending takes no new orders (issues/303)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T08:00:00Z'));
    ROWS = {
      1: child(1),
      2: child(2, { kilograms: 4 }),
      10: collection(10, '2026-10-06', { kilograms: 14 }),
    };
  });

  it.each(['processed', 'lastmile', 'delivered'])('a %s -R of the new day gets a new pending -R next to it', async (status) => {
    ROWS[20] = collection(20, '2026-10-13', { status, kilograms: 6, units: 1 });
    ROWS[3] = child(3, { status: 'delivered', collection_order: { id: 20 }, collection_pickup_date: '2026-10-13', kilograms: 6 });
    await saveOrderOne({ collection_pickup_date: '2026-10-13' });
    const moved = collectionOf(1);
    expect([10, 20]).not.toContain(moved);
    expect(ROWS[moved]).toMatchObject({ is_collection_order: true, status: 'pending', collection_pickup_date: '2026-10-13' });
    expect(ROWS[20]).toMatchObject({ status, kilograms: 6, units: 1 });
  });

  it('an order in a -R that moved on stays in it when saved without moving', async () => {
    ROWS[10].status = 'processed';
    await saveOrderOne({ units: 1 });
    expect(collectionOf(1)).toBe(10);
  });
});
