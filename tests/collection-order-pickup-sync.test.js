'use strict';

/**
 * issues/267 (review 8, 2026-10-20): the driver marked a farm collection
 * order (-R) «Recollit», but the orders it collects kept pickup_date NULL:
 * the -R view listed them as not collected and each one still asked for a
 * «Recollir» of its own. The -R pickup (set, moved or undone) now goes to its
 * open orders; one with a pickup of its own keeps it.
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

function stubStrapi() {
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
          if (uid === 'api::contact.contact') return { id: where.id, name: 'Punt' };
          if (uid === 'api::route.route') return { id: where.id, monday: true, active: true };
          return null;
        }),
        findMany: jest.fn(async ({ where } = {}) =>
          uid === 'api::order.order' ? Object.values(ROWS).filter((r) => matches(r, where)) : [],
        ),
        update: jest.fn(async ({ where, data }) => {
          if (uid !== 'api::order.order') return null;
          const { _internal, ...rest } = data;
          ROWS[where.id] = { ...ROWS[where.id], ...rest };
          return ROWS[where.id];
        }),
        count: jest.fn(async () => 0),
        create: jest.fn(async ({ data }) => {
          const id = Math.max(...Object.keys(ROWS).map(Number)) + 1;
          ROWS[id] = { id, ...data };
          return ROWS[id];
        }),
      })),
    },
  };
}

const AT = '2026-10-20T07:30:00.000Z';
const OWN = '2026-10-19T10:00:00.000Z';

async function setPickup(pickup_date, pickup_user) {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
  const lifecycles = require('../src/api/order/content-types/order/lifecycles');
  const event = { params: { where: { id: 10 }, data: { pickup_date, pickup_user } }, state: {} };
  await lifecycles.beforeUpdate(event);
  ROWS[10] = { ...ROWS[10], pickup_date, pickup_user: pickup_user ? { id: pickup_user } : null };
  await lifecycles.afterUpdate(event);
}

const child = (id, extra = {}) => ({
  id,
  status: 'processed',
  kilograms: 1,
  units: 1,
  collection_order: { id: 10 },
  pickup_date: null,
  pickup_user: null,
  ...extra,
});

describe('pickup of a collection order goes to its orders (issues/267)', () => {
  beforeEach(() => {
    ROWS = {
      1: child(1),
      2: child(2),
      3: child(3, { status: 'cancelled' }),
      4: child(4, { pickup_date: OWN, pickup_user: 8 }),
      10: { id: 10, is_collection_order: true, status: 'processed', pickup_date: null },
    };
  });

  it('marks its open orders collected by the same driver', async () => {
    await setPickup(AT, 7);
    expect(ROWS[1]).toMatchObject({ pickup_date: AT, pickup_user: 7 });
    expect(ROWS[2]).toMatchObject({ pickup_date: AT, pickup_user: 7 });
    expect(ROWS[3].pickup_date).toBeNull();
    expect(ROWS[4]).toMatchObject({ pickup_date: OWN, pickup_user: 8 });
  });

  it('undoes it on the orders it had marked', async () => {
    await setPickup(AT, 7);
    await setPickup(null, null);
    expect(ROWS[1]).toMatchObject({ pickup_date: null, pickup_user: null });
    expect(ROWS[2].pickup_date).toBeNull();
    expect(ROWS[4]).toMatchObject({ pickup_date: OWN, pickup_user: 8 });
  });

  it('leaves the orders alone when the pickup does not change', async () => {
    ROWS[10].pickup_date = AT;
    await setPickup(AT, 7);
    expect(ROWS[1].pickup_date).toBeNull();
  });
});
