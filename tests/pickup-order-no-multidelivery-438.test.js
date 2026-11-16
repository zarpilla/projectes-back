'use strict';

/**
 * issues/438 (Joel, Diligència, 2026-11-16): a pickup order (-R) got the
 * multidelivery discount. Two -R of a farm on the same day both took 20 %, and
 * with the farm's pickup discount (99,9 %) the line came to −119,9 %
 * (25862, 25867). A -R is not a delivery: it never gets the discount and never
 * gives it to the orders of its point and day. Invoiced orders keep the amount
 * they were invoiced with.
 */

const path = require('path');

let ROWS;

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key] && typeof row[key] === 'object' ? row[key].id : row[key];
    if (cond && typeof cond === 'object') {
      if ('$notIn' in cond) return !cond.$notIn.includes(value);
      if ('$in' in cond) return cond.$in.includes(value);
      if ('$ne' in cond) return value !== cond.$ne;
      if ('$gt' in cond) return Number(value) > cond.$gt;
      return true;
    }
    return value === cond;
  });

const LOGGED = [];
const RAW_UPDATES = [];

function stubStrapi() {
  const query = jest.fn((uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order') return ROWS[where.id] ? { ...ROWS[where.id] } : null;
      if (uid === 'plugin::users-permissions.user') return { id: where.id };
      return null;
    }),
    findMany: jest.fn(async ({ where } = {}) =>
      uid === 'api::order.order' ? Object.values(ROWS).filter((r) => matches(r, where)).map((r) => ({ ...r })) : [],
    ),
    update: jest.fn(async ({ where, data }) => {
      if (uid !== 'api::order.order') return null;
      const { _internal, ...rest } = data;
      ROWS[where.id] = { ...ROWS[where.id], ...rest };
      return ROWS[where.id];
    }),
    create: jest.fn(async ({ data }) => {
      if (uid === 'api::document-change-log.document-change-log') LOGGED.push(data);
      return data;
    }),
    count: jest.fn(async () => 0),
  }));
  const connection = jest.fn(() => ({
    whereIn: (col, ids) => ({
      update: async (data) => {
        RAW_UPDATES.push({ ids, data });
        for (const id of ids) ROWS[id] = { ...ROWS[id], ...data };
      },
    }),
  }));
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: { query, connection, metadata: { get: () => ({ tableName: 'orders' }) } },
    query,
    contentType: () => ({ attributes: { multidelivery_discount: { type: 'decimal' } } }),
    getModel: () => ({ attributes: { multidelivery_discount: { type: 'decimal' } } }),
  };
}

const order = (id, status, multidelivery_discount, extra = {}) => ({
  id,
  status,
  multidelivery_discount,
  volume_discount: 0,
  owner: { id: 100 },
  contact: { id: 77 },
  estimated_delivery_date: '2026-11-18',
  ...extra,
});
const pickup = (id, status, md, extra = {}) =>
  order(id, status, md, { is_collection_order: true, contact_pickup_discount: 99.9, ...extra });

function load() {
  jest.resetModules();
  stubStrapi();
  jest.doMock('../src/services/me-settings', () => ({
    getMe: async () => ({ orders_options: { multidelivery_discount: 20 } }),
  }));
  return require('../src/api/order/content-types/order/lifecycles');
}

describe('a pickup order (-R) never gets the multidelivery discount (issues/438)', () => {
  it('a second -R of the farm that day gets none', async () => {
    ROWS = { 1: pickup(1, 'pending', 0) };
    const { processMultideliveryDiscountForCurrentOrder } = load().multideliveryHelpers;
    const data = { ...pickup(0, 'pending', 0), id: undefined, contact: 77 };
    await processMultideliveryDiscountForCurrentOrder(0, data);
    expect(Number(data.multidelivery_discount)).toBe(0);
  });

  it('an open -R that has it loses it on its next save, a delivered one too', async () => {
    for (const status of ['pending', 'processed', 'delivered']) {
      ROWS = { 1: pickup(1, status, 20), 2: pickup(2, 'pending', 20) };
      const { processMultideliveryDiscountForCurrentOrder } = load().multideliveryHelpers;
      const data = { ...ROWS[1] };
      await processMultideliveryDiscountForCurrentOrder(1, data);
      expect(data.multidelivery_discount).toBe(0);
    }
  });

  it('an invoiced -R, or one on an invoice, keeps what it was invoiced with', async () => {
    ROWS = { 1: pickup(1, 'invoiced', 20), 2: pickup(2, 'delivered', 20, { emitted_invoice: { id: 5 } }) };
    const { processMultideliveryDiscountForCurrentOrder } = load().multideliveryHelpers;
    const invoiced = { ...ROWS[1] };
    await processMultideliveryDiscountForCurrentOrder(1, invoiced);
    expect(invoiced.multidelivery_discount).toBe(20);
    // the merged row of an update has its invoice unpopulated
    const onInvoice = { ...ROWS[2], emitted_invoice: undefined };
    await processMultideliveryDiscountForCurrentOrder(2, onInvoice);
    expect(onInvoice.multidelivery_discount).toBe(20);
  });

  it('a -R gives no discount to the delivery to its point that day', async () => {
    ROWS = { 1: pickup(1, 'pending', 0) };
    const lifecycles = load();
    const data = order(0, 'pending', 0, { contact: 77, owner: 100 });
    await lifecycles.multideliveryHelpers.processMultideliveryDiscountForCurrentOrder(0, data);
    expect(Number(data.multidelivery_discount)).toBe(0);
  });

  it('saving a -R reprices none of the orders of its point and day', async () => {
    ROWS = { 1: pickup(1, 'pending', 0), 2: order(2, 'pending', 0), 3: pickup(3, 'pending', 0) };
    const lifecycles = load();
    await lifecycles.afterCreate({ result: { id: 1 }, state: {} });
    expect(ROWS[2].multidelivery_discount).toBe(0);
    expect(ROWS[3].multidelivery_discount).toBe(0);
  });

  it('two deliveries still give each other the discount, a -R alongside does not get it', async () => {
    ROWS = { 1: order(1, 'pending', 20), 2: order(2, 'pending', 0), 3: pickup(3, 'pending', 0) };
    const lifecycles = load();
    await lifecycles.afterCreate({ result: { id: 1 }, state: {} });
    expect(ROWS[2].multidelivery_discount).toBe(20);
    expect(ROWS[3].multidelivery_discount).toBe(0);
  });
});

describe('check-multidelivery preview (issues/438)', () => {
  let orders;
  function loadController() {
    jest.resetModules();
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      log: { warn: () => {}, info: () => {} },
      documents: () => ({ findFirst: async () => ({ orders_options: { multidelivery_discount: 20 } }) }),
      db: {
        query: (uid) => ({
          findOne: async () => null,
          findMany: async () => (uid === 'api::order.order' ? orders : []),
        }),
      },
    };
    return require(path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'))({
      strapi: global.strapi,
    });
  }
  const body = { date: '2026-11-18', contactId: 77, ownerId: 100 };

  it('a -R of the point that day does not make a new order multidelivery', async () => {
    orders = [{ id: 1, status: 'pending', is_collection_order: true }];
    const res = await loadController().checkMultidelivery({ request: { body } });
    expect(res.multidelivery_discount).toBe(0);
  });

  it('a -R previews none, even with another -R or a delivery that day', async () => {
    orders = [
      { id: 1, status: 'pending', is_collection_order: true },
      { id: 2, status: 'pending', is_collection_order: true },
      { id: 3, status: 'pending' },
    ];
    const res = await loadController().checkMultidelivery({ request: { body: { ...body, id: 1 } } });
    expect(res.multidelivery_discount).toBe(0);
  });

  it('another delivery still does', async () => {
    orders = [{ id: 3, status: 'pending' }];
    const res = await loadController().checkMultidelivery({ request: { body } });
    expect(res.multidelivery_discount).toBe(20);
  });
});

describe('startup fix of the open orders (issues/438)', () => {
  function loadFix() {
    jest.resetModules();
    stubStrapi();
    LOGGED.length = 0;
    RAW_UPDATES.length = 0;
    jest.doMock('../src/services/change-log', () => ({
      logChanges: async (uid, entries) => LOGGED.push(...entries),
    }));
    return require('../src/services/drop-pickup-order-multidelivery').dropPickupOrderMultidelivery;
  }

  it('takes the discount off open -R and off orders whose only other order was a -R, never an invoiced one', async () => {
    ROWS = {
      // the 25862 / 25867 case: two -R of a farm, 99,9 % + 20 %
      1: pickup(1, 'pending', 20),
      2: pickup(2, 'delivered', 20),
      3: pickup(3, 'invoiced', 20),
      4: pickup(4, 'delivered', 20, { emitted_invoice: { id: 9 } }),
      5: pickup(5, 'cancelled', 20),
      // a delivery whose only other order that day is a -R
      6: order(6, 'pending', 20, { contact: { id: 88 } }),
      7: pickup(7, 'pending', 0, { contact: { id: 88 } }),
      // real multidelivery stays
      8: order(8, 'processed', 20, { contact: { id: 99 } }),
      9: order(9, 'invoiced', 20, { contact: { id: 99 } }),
      // an invoiced delivery that only had a -R alongside keeps it
      10: order(10, 'invoiced', 20, { contact: { id: 111 } }),
      11: pickup(11, 'invoiced', 0, { contact: { id: 111 } }),
    };
    const run = loadFix();
    const fixed = await run();
    expect(fixed.sort((a, b) => a - b)).toEqual([1, 2, 6]);
    expect(ROWS[1].multidelivery_discount).toBe(0);
    expect(ROWS[2].multidelivery_discount).toBe(0);
    expect(ROWS[6].multidelivery_discount).toBe(0);
    for (const id of [3, 4, 5, 8, 9, 10]) expect(ROWS[id].multidelivery_discount).toBe(20);
    expect(LOGGED.map((e) => e.row.id).sort((a, b) => a - b)).toEqual([1, 2, 6]);
    expect(LOGGED[0].changes[0]).toEqual({ field: 'multidelivery_discount', from: 20, to: 0 });
  });

  it('a second run changes nothing', async () => {
    ROWS = { 1: pickup(1, 'pending', 0), 2: order(2, 'pending', 20), 3: order(3, 'pending', 20) };
    const run = loadFix();
    expect(await run()).toEqual([]);
    expect(RAW_UPDATES).toEqual([]);
  });
});
