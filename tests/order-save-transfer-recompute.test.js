'use strict';

/**
 * issues/296 (review 9, 2026-10-20): the order form sends pickup, route and
 * date on every save, and beforeUpdate took "sent" for "changed": saving
 * processed order 24873 (route date 2026-10-06) without changes made it a
 * transfer dated 2026-10-06, and invoiced 18818 one dated 2026-05-05. Since
 * 156 the pickup's town is read, so thousands of old orders would flip on
 * their next save. The transfer is recomputed only when the pickup, route,
 * collection point or dates really change, and never for a delivered,
 * invoiced or cancelled order.
 */

let ROWS;
let UPDATES;

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
      // Magatzem Artés, in town 3
      if (uid === 'api::pickup.pickup') return { id: where.id, pickup: false, city: { id: 3 } };
      if (uid === 'api::route.route') return { id: where.id, transfer_pickup: { id: 1 } };
      return null;
    }),
    findMany: jest.fn(async () => {
      if (uid === 'api::route.route') return [{ id: 16, is_transfer_route: true, active: true, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true }];
      // no route travels to town 3: a transfer is needed
      return [];
    }),
    update: jest.fn(async (args) => {
      UPDATES.push({ uid, ...args });
      return null;
    }),
    count: jest.fn(async () => 0),
  }));
  global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
}

const stored = (status, extra = {}) => ({
  id: 24873,
  status,
  is_collection_order: false,
  manual_transfer_route: false,
  transfer: false,
  price: 7.5,
  kilograms: 12,
  pickup: { id: 3 },
  route: { id: 25 },
  collection_point: null,
  estimated_delivery_date: '2026-10-06',
  collection_pickup_date: null,
  ...extra,
});

// what the order form sends on a save without changes
const formSave = (row, extra = {}) => ({
  status: row.status,
  pickup: 3,
  route: 25,
  estimated_delivery_date: '2026-10-06T00:00:00.000Z',
  collection_pickup_date: null,
  manual_transfer_route: false,
  price: 7.5,
  kilograms: 12,
  ...extra,
});

function load() {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ orders_options: {} }) }));
  return require('../src/api/order/content-types/order/lifecycles');
}

const save = async (row, data) => {
  ROWS = { [row.id]: row };
  UPDATES = [];
  const lifecycles = load();
  const event = { params: { where: { id: row.id }, data }, state: {} };
  await lifecycles.beforeUpdate(event);
  return event.params.data;
};

describe('the transfer recompute of an order save (issues/296)', () => {
  it('does not run on a save without changes', async () => {
    const row = stored('processed');
    const data = await save(row, formSave(row));
    expect(data).not.toHaveProperty('transfer');
    expect(data).not.toHaveProperty('transfer_route_date');
  });

  it('never runs for a delivered, invoiced or cancelled order', async () => {
    for (const status of ['delivered', 'invoiced', 'cancelled']) {
      const row = stored(status);
      const data = await save(row, formSave(row, { route: 26 }));
      expect(data).not.toHaveProperty('transfer');
    }
  });

  it('still runs when an open order changes route', async () => {
    const row = stored('pending');
    const data = await save(row, formSave(row, { route: 26 }));
    expect(data.transfer).toBe(true);
    expect(data.transfer_route).toBe(16);
  });

  it('still runs when an open order changes day', async () => {
    const row = stored('pending');
    const data = await save(row, formSave(row, { estimated_delivery_date: '2026-10-07' }));
    expect(data.transfer).toBe(true);
    expect(data.transfer_route_date).toBe('2026-10-07');
  });

  it('runs when the manual flag is switched off', async () => {
    const row = stored('pending', { manual_transfer_route: true });
    const data = await save(row, formSave(row));
    expect(data.transfer).toBe(true);
  });

  // Follow-up (verification of 296, 2026-10-20): the form recomputed the
  // transfer when it loaded processed 24871 and invoiced 15068 and sent
  // `transfer: true` + origin pickup 3 with a save without changes; the API
  // stored them and afterUpdate filled in transfer route 25 and a past date.
  const loadedTransfer = { transfer: true, transfer_pickup_origin: 3, transfer_pickup_destination: null };

  it('keeps the stored transfer of an open order when a save without changes sends another', async () => {
    const row = stored('processed');
    const data = await save(row, formSave(row, loadedTransfer));
    expect(data).not.toHaveProperty('transfer');
    expect(data).not.toHaveProperty('transfer_pickup_origin');
    // the same value as stored goes through
    expect(data.transfer_pickup_destination).toBeNull();
  });

  it('keeps the stored transfer of a delivered, invoiced or cancelled order whatever changes', async () => {
    for (const status of ['delivered', 'invoiced', 'cancelled']) {
      const row = stored(status);
      const data = await save(row, formSave(row, { ...loadedTransfer, route: 26, transfer_route: 16 }));
      expect(data).not.toHaveProperty('transfer');
      expect(data).not.toHaveProperty('transfer_pickup_origin');
      expect(data).not.toHaveProperty('transfer_route');
    }
  });

  it('keeps a manual transfer edit of an open order', async () => {
    const row = stored('pending', { transfer: true, transfer_route: { id: 16 } });
    const data = await save(row, formSave(row, { manual_transfer_route: true, transfer_route: 17 }));
    expect(data.transfer_route).toBe(17);
  });

  it('does not fill in a transfer route or date for an invoiced order after the save', async () => {
    const row = stored('invoiced', { transfer: true, transfer_route: null, transfer_route_date: null });
    ROWS = { [row.id]: row };
    UPDATES = [];
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: row.id }, data: { status: 'invoiced' } },
      state: { previousOrderData: row },
      result: row,
    });
    expect(UPDATES.filter((u) => u.uid === 'api::order.order' && u.data && 'transfer_route' in u.data)).toEqual([]);
  });

  it('still fills them in for an open transfer order', async () => {
    const row = stored('pending', { transfer: true, transfer_route: null, transfer_route_date: null });
    ROWS = { [row.id]: row };
    UPDATES = [];
    const lifecycles = load();
    await lifecycles.afterUpdate({
      params: { where: { id: row.id }, data: { status: 'pending' } },
      state: { previousOrderData: row },
      result: row,
    });
    const fill = UPDATES.find((u) => u.uid === 'api::order.order' && u.data && 'transfer_route' in u.data);
    expect(fill.data.transfer_route).toBe(16);
  });
});
