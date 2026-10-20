'use strict';

/**
 * issues/287 (review 9, 2026-10-20): saving invoiced order 14958 (invoice 633
 * at 7,50 €) from the orders list's quick edit sent the price of today's
 * rate, 7,70 €, and the order no longer matched its invoice. The front no
 * longer reprices it; the API also keeps the price of an order that is and
 * stays invoiced (the price sent is dropped, the rest of the save goes on).
 */

let ROWS;

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) =>
      uid === 'api::order.order' && ROWS[where.id] ? { ...ROWS[where.id] } : null,
    ),
    findMany: jest.fn(async () => []),
    update: jest.fn(async () => null),
    count: jest.fn(async () => 0),
  }));
  global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
}

const stored = (status) => ({ id: 14958, status, price: '7.50', kilograms: 12, is_collection_order: false });

const save = async (row, data) => {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ orders_options: {} }) }));
  ROWS = { [row.id]: row };
  const lifecycles = require('../src/api/order/content-types/order/lifecycles');
  const event = { params: { where: { id: row.id }, data }, state: {} };
  await lifecycles.beforeUpdate(event);
  return event.params.data;
};

describe('the price of an invoiced order (issues/287)', () => {
  it('is kept when a save sends another one', async () => {
    const data = await save(stored('invoiced'), { price: 7.7, units: 2 });
    expect(data).not.toHaveProperty('price');
    expect(data.units).toBe(2);
  });

  it('a save that sends the same price goes through unchanged', async () => {
    const data = await save(stored('invoiced'), { price: 7.5 });
    expect(data.price).toBe(7.5);
  });

  it('changes on an order that is not invoiced, or leaves «Facturada» in the same save', async () => {
    expect((await save(stored('processed'), { price: 7.7 })).price).toBe(7.7);
    expect((await save(stored('invoiced'), { price: 7.7, status: 'delivered' })).price).toBe(7.7);
  });
});
