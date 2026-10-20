'use strict';

/**
 * issues/286 (review 9, 2026-10-20): the volume-discount recompute rewrote
 * every order of the owner/route/day group, invoiced ones included. On
 * Diligència a new order for La Dotzena on route 12 on 2026-09-30 took the
 * group to the threshold and the 10 orders already on issued invoice 869
 * went from 0 to 2 € off, 20 € less than the invoice. The removal path (the
 * group dropping below the threshold) stripped it the same way. An invoiced,
 * delivered or invoice-linked sibling keeps the discount it was charged with,
 * as for the multidelivery discount (issues/233); it still counts.
 */

let ROWS;
const ROUTE = { id: 12, volume_discount_number_of_orders: 3, volume_discount_price: 2 };

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key] && typeof row[key] === 'object' ? row[key].id : row[key];
    if (cond && typeof cond === 'object') {
      if ('$notIn' in cond) return !cond.$notIn.includes(value);
      if ('$in' in cond) return cond.$in.includes(value);
      return true;
    }
    return value === cond;
  });

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
      if (uid === 'api::route.route') return where.id === ROUTE.id ? { ...ROUTE } : null;
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
  }));
  global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
}

const order = (id, status, volume_discount, extra = {}) => ({
  id,
  status,
  volume_discount,
  multidelivery_discount: 0,
  owner: { id: 65 },
  route: { id: 12 },
  contact: { id: id + 1000 },
  estimated_delivery_date: '2026-09-30',
  ...extra,
});

function load() {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ orders_options: {} }) }));
  return require('../src/api/order/content-types/order/lifecycles');
}

describe('volume-discount recompute of the sibling orders (issues/286)', () => {
  it('a new order reaching the threshold gives the discount to the open siblings only', async () => {
    ROWS = {
      1: order(1, 'pending', 2),
      2: order(2, 'invoiced', 0),
      3: order(3, 'pending', 0),
      4: order(4, 'delivered', 0),
      5: order(5, 'processed', 0, { emitted_invoice: { id: 869 } }),
    };
    const lifecycles = load();
    await lifecycles.afterCreate({ result: { id: 1 }, state: {} });
    expect(ROWS[2].volume_discount).toBe(0);
    expect(ROWS[3].volume_discount).toBe(2);
    expect(ROWS[4].volume_discount).toBe(0);
    expect(ROWS[5].volume_discount).toBe(0);
  });

  it('a group dropping below the threshold keeps the discount of its invoiced orders', async () => {
    ROWS = {
      1: order(1, 'cancelled', 2),
      2: order(2, 'invoiced', 2),
      3: order(3, 'pending', 2),
    };
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: 1 }, data: { status: 'cancelled' } },
      result: { id: 1 },
      state: { previousOrderData: { ...ROWS[1], status: 'pending' } },
    });
    expect(ROWS[2].volume_discount).toBe(2);
    expect(ROWS[3].volume_discount).toBe(0);
  });

  it('moving an order out of its group keeps the discount of the invoiced orders left behind', async () => {
    ROWS = {
      1: order(1, 'pending', 2, { estimated_delivery_date: '2026-10-01' }),
      2: order(2, 'processed', 2, { emitted_invoice: { id: 869 } }),
      3: order(3, 'pending', 2),
    };
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: 1 }, data: { estimated_delivery_date: '2026-10-01' } },
      result: { id: 1 },
      state: {
        previousOrderData: { ...ROWS[1], estimated_delivery_date: '2026-09-30' },
        previousRelations: { owner: { id: 65 }, route: { id: 12 }, contact: { id: 1001 } },
      },
    });
    expect(ROWS[2].volume_discount).toBe(2);
    expect(ROWS[3].volume_discount).toBe(0);
  });
});
