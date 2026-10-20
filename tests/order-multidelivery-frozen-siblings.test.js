'use strict';

/**
 * issues/233 (review 7, 2026-10-19): a new order for the same delivery point
 * and day rewrote the multidelivery discount of every sibling, invoiced and
 * delivered ones included. Diligència 24470 was on invoice 889 at 8,73 € with
 * 0 % and went to 20 % (6,98 €) when 24904 was created; in production 23810
 * (invoice 2026-243) changed the same way. A sibling that is invoiced,
 * delivered or on an invoice keeps its discount; it still counts towards the
 * group. Also: the day the hooks group by is the Madrid day of the form's ISO
 * date, whatever the server's timezone.
 */

let ROWS;

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

const order = (id, status, multidelivery_discount, extra = {}) => ({
  id,
  status,
  multidelivery_discount,
  volume_discount: 0,
  owner: { id: 100 },
  contact: { id: 2232 },
  estimated_delivery_date: '2026-10-01',
  ...extra,
});

function load() {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({
    getMe: async () => ({ orders_options: { multidelivery_discount: 20 } }),
  }));
  return require('../src/api/order/content-types/order/lifecycles');
}

describe('multidelivery recompute of the sibling orders (issues/233)', () => {
  it('a new order gives the discount to the open siblings only', async () => {
    ROWS = {
      1: order(1, 'pending', 20),
      2: order(2, 'invoiced', 0),
      3: order(3, 'pending', 0),
      4: order(4, 'delivered', 0),
      5: order(5, 'processed', 0, { emitted_invoice: { id: 889 } }),
    };
    const lifecycles = load();
    await lifecycles.afterCreate({ result: { id: 1 }, state: {} });
    expect(ROWS[2].multidelivery_discount).toBe(0);
    expect(ROWS[3].multidelivery_discount).toBe(20);
    expect(ROWS[4].multidelivery_discount).toBe(0);
    expect(ROWS[5].multidelivery_discount).toBe(0);
  });

  it('cancelling the other order leaves an invoiced sibling as it was charged', async () => {
    ROWS = {
      1: order(1, 'cancelled', 20),
      2: order(2, 'invoiced', 20),
    };
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: 1 }, data: { status: 'cancelled' } },
      result: { id: 1 },
      state: { previousOrderData: { ...ROWS[1], status: 'pending' } },
    });
    expect(ROWS[2].multidelivery_discount).toBe(20);
  });

  it('cancelling the other order still removes it from an open sibling', async () => {
    ROWS = {
      1: order(1, 'cancelled', 20),
      3: order(3, 'pending', 20),
    };
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: 1 }, data: { status: 'cancelled' } },
      result: { id: 1 },
      state: { previousOrderData: { ...ROWS[1], status: 'pending' } },
    });
    expect(ROWS[3].multidelivery_discount).toBe(0);
  });
});

describe('the day the discounts group by (issues/233)', () => {
  it("is the Madrid day of the form's ISO date, whatever the server timezone", () => {
    const { toQueryDay } = require('../src/services/date-fields');
    expect(toQueryDay('2026-09-30T22:00:00.000Z')).toBe('2026-10-01');
    expect(toQueryDay('2026-10-01')).toBe('2026-10-01');
    expect(toQueryDay(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('is what the multidelivery and volume lookups query', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of [
      'content-types/order/lifecycles.js',
      'services/volume-discount.js',
      'controllers/order.js',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'order', file), 'utf8');
      expect(src).not.toMatch(/estimated_delivery_date: moment\(/);
      expect(src).toMatch(/estimated_delivery_date: toQueryDay\(date\)/);
    }
  });
});
