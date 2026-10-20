'use strict';

/**
 * issues/302 (La Diligència, 2026-10-20): on Monday 2026-10-19 order 25432
 * was saved with its farm pickup on Tuesday 2026-10-13, a week already gone,
 * and collection order 25433-R was created for that day. The backend took
 * `collection_pickup_date` as sent. The user's rule: no past pickup dates, for
 * anyone. On update only a changed date is checked, so an order whose pickup
 * has passed can still be saved (or invoiced) without moving it.
 */

let ROWS;

function stubStrapi() {
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where } = {}) =>
          uid === 'api::order.order' && ROWS[where.id] ? { ...ROWS[where.id] } : null,
        ),
        findMany: jest.fn(async () => []),
        update: jest.fn(async ({ data }) => data),
        count: jest.fn(async () => 0),
        create: jest.fn(async ({ data }) => data),
      })),
    },
  };
}

const mainOrder = (extra = {}) => ({
  id: 25432,
  status: 'pending',
  owner: { id: 61 },
  estimated_delivery_date: '2026-10-21',
  collection_point: { id: 7 },
  collection_pickup_route: { id: 11 },
  collection_pickup_date: '2026-10-13',
  ...extra,
});

describe('farm pickup dates in the past (issues/302)', () => {
  let lifecycles;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T15:34:00Z'));
    ROWS = { 25432: mainOrder() };
    stubStrapi();
    lifecycles = require('../src/api/order/content-types/order/lifecycles');
  });

  afterEach(() => jest.useRealTimers());

  const create = (data) => lifecycles.beforeCreate({ params: { data }, state: {} });
  const update = (data) => lifecycles.beforeUpdate({ params: { where: { id: 25432 }, data }, state: {} });

  test('a new order with a pickup date before today is refused', async () => {
    await expect(
      create({ estimated_delivery_date: '2026-10-21', collection_pickup_date: '2026-10-13' }),
    ).rejects.toThrow(/data de recollida/);
  });

  test('the form sends the Madrid midnight as UTC: the day before is still refused', async () => {
    await expect(
      create({ estimated_delivery_date: '2026-10-21', collection_pickup_date: '2026-10-17T22:00:00.000Z' }),
    ).rejects.toThrow(/data de recollida/);
  });

  test('today and later are accepted', async () => {
    await expect(create({ collection_pickup_date: '2026-10-19' })).resolves.not.toThrow();
    await expect(create({ collection_pickup_date: '2026-10-19T22:00:00.000Z' })).resolves.not.toThrow();
  });

  test('moving the pickup of a saved order to a past day is refused', async () => {
    ROWS[25432] = mainOrder({ collection_pickup_date: '2026-10-20' });
    await expect(update({ collection_pickup_date: '2026-10-13' })).rejects.toThrow(/data de recollida/);
  });

  test('re-saving an order whose pickup has passed, without moving it, is accepted', async () => {
    await expect(update({ collection_pickup_date: '2026-10-13', units: 2 })).resolves.not.toThrow();
  });

  test('moving a past pickup to a future day is accepted', async () => {
    await expect(update({ collection_pickup_date: '2026-10-20' })).resolves.not.toThrow();
  });

  test('internal writes of the collection-order hooks are not checked', async () => {
    await expect(
      create({ is_collection_order: true, _internal: true, collection_pickup_date: '2026-10-13' }),
    ).resolves.not.toThrow();
  });
});
