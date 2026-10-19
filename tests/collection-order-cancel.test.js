'use strict';

/**
 * issues/217 (the user's decision, 2026-10-19): when a main order is
 * cancelled, its generated collection order is cancelled too, but only when no
 * other order left in it is still active (not cancelled), whoever cancels it
 * (member, office, driver: the order lifecycles, not the API).
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

const child = (id, status) => ({
  id,
  status,
  owner: { id: 100 },
  collection_pickup_route: { id: 3 },
  collection_point: { id: 30 },
  collection_order: { id: 10 },
  collection_pickup_date: '2026-10-21',
});

/** Cancels order 1 the way the update hooks see it. */
async function cancelOrderOne() {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
  const lifecycles = require('../src/api/order/content-types/order/lifecycles');
  const event = { params: { where: { id: 1 }, data: { status: 'cancelled' } }, state: {} };
  await lifecycles.beforeUpdate(event);
  ROWS[1] = { ...ROWS[1], status: 'cancelled' };
  await lifecycles.afterUpdate(event);
}

describe('cancelling the main order of a collection order (issues/217)', () => {
  beforeEach(() => {
    ROWS = {
      1: child(1, 'pending'),
      10: { id: 10, is_collection_order: true, status: 'pending', kilograms: 5, units: 1 },
    };
  });

  it('cancels the collection order when it was its only order', async () => {
    await cancelOrderOne();
    expect(ROWS[10].status).toBe('cancelled');
  });

  it('keeps it while another order in it is active', async () => {
    ROWS[2] = { ...child(2, 'pending'), kilograms: 3, units: 1 };
    await cancelOrderOne();
    expect(ROWS[10].status).toBe('pending');
    expect(ROWS[10]).toMatchObject({ kilograms: 3, units: 1 });
  });

  it('keeps it while an order in it is invoiced (not cancelled)', async () => {
    ROWS[2] = child(2, 'invoiced');
    await cancelOrderOne();
    expect(ROWS[10].status).toBe('pending');
  });

  it("doesn't generate a new one when the cancelled order is saved again", async () => {
    await cancelOrderOne();
    await cancelOrderOne();
    expect(Object.values(ROWS).filter((r) => r.is_collection_order)).toHaveLength(1);
  });
});
