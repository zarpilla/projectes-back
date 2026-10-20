'use strict';

/**
 * issues/266 (review 8, 2026-10-20): an order set back from Lliurada to
 * Processada kept its delivery_date, so the Comandes list and the tracking
 * still showed it as delivered. Setting an order back before delivery clears
 * its delivery date; delivering it still fills it in.
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

async function update(id, data) {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({}) }));
  const lifecycles = require('../src/api/order/content-types/order/lifecycles');
  const event = { params: { where: { id }, data: { ...data } }, state: {} };
  await lifecycles.beforeUpdate(event);
  return event.params.data;
}

describe('delivery date of an order set back (issues/266)', () => {
  beforeEach(() => {
    ROWS = {
      1: { id: 1, status: 'delivered', delivery_date: '2026-10-20', estimated_delivery_date: '2026-10-20', price: 5 },
    };
  });

  it.each([['processed'], ['pending'], ['deposited'], ['lastmile'], ['distributing']])(
    'clears it when the order goes back to %s',
    async (status) => {
      const data = await update(1, { status, delivery_date: '2026-10-20' });
      expect(data.delivery_date).toBeNull();
    },
  );

  it('fills it in when the order is delivered', async () => {
    ROWS[1] = { ...ROWS[1], status: 'processed', delivery_date: null };
    const data = await update(1, { status: 'delivered', estimated_delivery_date: '2026-10-20' });
    expect(data.delivery_date).toBe('2026-10-20');
  });

  it('keeps it when the order is invoiced or the status is not sent', async () => {
    expect((await update(1, { status: 'invoiced' })).delivery_date).toBeUndefined();
    expect((await update(1, { comments: 'x' })).delivery_date).toBeUndefined();
  });
});
