'use strict';

/**
 * issues/119 (2026-10-18): orders had no history. `orders_trackings` existed
 * but both writes to it were commented out (in v3 already), so nobody could
 * tell who moved an order to which status, or when, to answer a customer
 * complaint or audit deliveries and invoicing.
 *
 * Orders now go through the invoice change log (services/change-log.js): a row
 * on create, on every save that changes a field (old -> new, user from the
 * request), on delete (kept afterwards), and on the raw-SQL status writes of
 * invoicing and of deleting the draft. GET /orders/:id/history reads it back.
 */

const path = require('path');

const ORDER = 'api::order.order';
const LOG = 'api::document-change-log.document-change-log';
const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js');
const INVOICE_LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);

const ATTRIBUTES = {
  status: { type: 'enumeration' },
  price: { type: 'decimal' },
  comments: { type: 'text' },
  emitted_invoice_datetime: { type: 'datetime' },
  multidelivery_discount: { type: 'decimal' },
  updatedAt: { type: 'datetime' },
  owner: { type: 'relation', relation: 'oneToOne', target: 'plugin::users-permissions.user' },
  route: { type: 'relation', relation: 'oneToOne', target: 'api::route.route' },
  emitted_invoice: { type: 'relation', relation: 'oneToOne', target: 'api::emitted-invoice.emitted-invoice' },
  incidences: { type: 'relation', relation: 'oneToMany', target: 'api::incidence.incidence' },
  lines: { type: 'component', repeatable: true, component: 'orders.lines' },
};

const baseOrder = () => ({
  id: 42,
  documentId: 'ord42',
  status: 'pending',
  price: '12.50',
  comments: null,
  emitted_invoice_datetime: null,
  multidelivery_discount: '0.00',
  updatedAt: new Date('2026-10-17T08:00:00Z'),
  owner: { id: 7, username: 'granja' },
  route: { id: 3, name: 'Ruta Nord' },
  emitted_invoice: null,
  incidences: [],
  lines: [{ id: 1, units: 2, kilograms: 10 }],
});

function mockStrapi({ rows = [], user = { id: 5, username: 'oficina' } } = {}) {
  const logs = [];
  const findOne = jest.fn(async () => (rows.length > 1 ? rows.shift() : rows[0]));
  const logQuery = {
    create: jest.fn(async ({ data }) => {
      logs.push(data);
      return data;
    }),
    findMany: jest.fn(async () => []),
  };
  global.strapi = {
    contentTypes: {
      [ORDER]: { attributes: ATTRIBUTES },
      'api::route.route': { attributes: { name: { type: 'string' }, code: { type: 'string' } } },
    },
    db: { query: jest.fn((uid) => (uid === LOG ? logQuery : { findOne })) },
    requestContext: { get: () => (user ? { state: { user } } : undefined) },
    log: { error: jest.fn() },
  };
  return { logs, findOne, logQuery };
}

let changeLog;

beforeEach(() => {
  jest.resetModules();
  changeLog = require('../src/services/change-log');
});

afterEach(() => {
  delete global.strapi;
  jest.restoreAllMocks();
});

const run = (action, params, result = { id: 42 }) =>
  changeLog.changeLogMiddleware({ uid: ORDER, action, params }, async () => result);

describe('order change history (issues/119)', () => {
  it('records a status change with who made it and the old and new value', async () => {
    const before = baseOrder();
    const after = { ...baseOrder(), status: 'deposited', updatedAt: new Date() };
    const { logs } = mockStrapi({ rows: [before, after] });

    await run('update', { documentId: 'ord42', data: { status: 'deposited' } });

    expect(logs).toEqual([
      expect.objectContaining({
        entity: 'order',
        entity_id: 42,
        action: 'update',
        user_id: 5,
        username: 'oficina',
        changes: [{ field: 'status', from: 'pending', to: 'deposited' }],
      }),
    ]);
  });

  it('records every changed field, recalculated ones included, in one row', async () => {
    const before = baseOrder();
    const after = {
      ...baseOrder(),
      route: { id: 4, name: 'Ruta Sud' },
      multidelivery_discount: '10.00',
      lines: [{ id: 9, units: 3, kilograms: 10 }],
    };
    const { logs } = mockStrapi({ rows: [before, after] });

    await run('update', { documentId: 'ord42' });

    expect(logs).toHaveLength(1);
    expect(logs[0].changes).toEqual([
      { field: 'multidelivery_discount', from: '0.00', to: '10.00' },
      { field: 'route', from: { id: 3, label: 'Ruta Nord' }, to: { id: 4, label: 'Ruta Sud' } },
      { field: 'lines', from: [{ units: 2, kilograms: 10 }], to: [{ units: 3, kilograms: 10 }] },
    ]);
  });

  it('adds nothing for a save that changes nothing', async () => {
    const { logs } = mockStrapi({ rows: [baseOrder(), { ...baseOrder(), price: 12.5, updatedAt: new Date() }] });
    await run('update', { documentId: 'ord42' });
    expect(logs).toEqual([]);
  });

  it('leaves the incidences out of the diff (linked outside the save)', async () => {
    const after = { ...baseOrder(), incidences: [{ id: 8 }] };
    const { logs, findOne } = mockStrapi({ rows: [baseOrder(), after] });

    await run('update', { documentId: 'ord42' });

    expect(logs).toEqual([]);
    expect(findOne.mock.calls[0][0].populate).not.toHaveProperty('incidences');
  });

  it('reads only the id and label columns of the related rows', async () => {
    const { findOne } = mockStrapi({ rows: [baseOrder()] });
    await run('update', { documentId: 'ord42' });
    const { populate } = findOne.mock.calls[0][0];
    expect(populate.route).toEqual({ select: ['id', 'code', 'name'] });
    expect(populate.lines).toBe(true);
  });

  it('records the creation and the deletion with the order as it was', async () => {
    const { logs } = mockStrapi({ rows: [baseOrder()] });

    await run('create', { data: {} });
    await run('delete', { documentId: 'ord42' });

    expect(logs.map((l) => l.action)).toEqual(['create', 'delete']);
    expect(logs[1]).toMatchObject({
      entity: 'order',
      entity_id: 42,
      snapshot: expect.objectContaining({ status: 'pending', route: { id: 3, label: 'Ruta Nord' } }),
    });
  });

  it('logs the known changes of a bulk raw UPDATE, skipping the ones that change nothing', async () => {
    const { logs } = mockStrapi();

    await changeLog.logChanges(ORDER, [
      { row: { id: 1 }, changes: [{ field: 'status', from: 'delivered', to: 'invoiced' }] },
      { row: { id: 2 }, changes: [{ field: 'status', from: 'invoiced', to: 'invoiced' }] },
    ]);

    expect(logs).toEqual([
      expect.objectContaining({
        entity: 'order',
        entity_id: 1,
        username: 'oficina',
        changes: [{ field: 'status', from: 'delivered', to: 'invoiced' }],
      }),
    ]);
  });

  it('never fails the write when the log does', async () => {
    const { logQuery } = mockStrapi();
    logQuery.create.mockRejectedValue(new Error('db down'));
    await expect(
      changeLog.logChanges(ORDER, [{ row: { id: 1 }, changes: [{ field: 'status', from: 'a', to: 'b' }] }]),
    ).resolves.toBeUndefined();
    expect(global.strapi.log.error).toHaveBeenCalled();
  });
});

describe('GET /orders/:id/history', () => {
  it('returns the order rows of the change log, newest first, even for a deleted order', async () => {
    const { logQuery } = mockStrapi();
    const rows = [
      { id: 2, entity: 'order', entity_id: 42, action: 'delete', changes: null, snapshot: {}, user_id: 5, username: 'oficina', createdAt: 't2' },
      { id: 1, entity: 'order', entity_id: 42, action: 'create', changes: null, snapshot: {}, user_id: 5, username: 'oficina', createdAt: 't1' },
    ];
    logQuery.findMany.mockResolvedValue(rows);
    global.strapi.contentType = () => ({ uid: ORDER, attributes: ATTRIBUTES });
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });

    const res = await ctrl.history({ params: { id: '42' } });

    expect(logQuery.findMany).toHaveBeenCalledWith({
      where: { entity: 'order', entity_id: 42 },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(res.map((r) => r.action)).toEqual(['delete', 'create']);
    expect(res[0]).not.toHaveProperty('entity');
  });

  it('is open to the logistics staff, not to members', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    const action = `${ORDER}.history`;
    expect(isAllowed(action, ['orders_admin'])).toBe(true);
    expect(isAllowed(action, ['orders_delivery'])).toBe(true);
    expect(isAllowed(action, ['projects'])).toBe(true);
    expect(isAllowed(action, ['orders'])).toBe(false);
  });
});

describe('raw status writes', () => {
  it('records the orders a draft deletion returns to delivered', async () => {
    const { logs } = mockStrapi();
    const invoice = { id: 55, code: 'ESBORRANY', state: 'draft', projects: [] };
    const stamp = new Date('2026-10-17T09:00:00Z');
    global.strapi.db.query = (uid) =>
      uid === LOG
        ? { create: async ({ data }) => logs.push(data) }
        : {
            findOne: async () => invoice,
            findMany: async () => [{ id: 1, status: 'invoiced', emitted_invoice_datetime: stamp }],
            deleteMany: async () => ({ count: 0 }),
          };
    global.strapi.db.connection = { raw: async () => ({}) };
    const lifecycles = require(INVOICE_LIFECYCLES);

    await lifecycles.beforeDelete({ params: { where: { id: 55 } } });

    expect(logs).toEqual([
      expect.objectContaining({
        entity: 'order',
        entity_id: 1,
        username: 'oficina',
        changes: [
          { field: 'status', from: 'invoiced', to: 'delivered' },
          { field: 'emitted_invoice', from: { id: 55, label: 'ESBORRANY' }, to: null },
          { field: 'emitted_invoice_datetime', from: stamp.toISOString(), to: null },
        ],
      }),
    ]);
  });

  it('records the orders an invoicing run marks invoiced, one row per order', async () => {
    const { logs } = mockStrapi();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const orders = [
      { id: 1, status: 'delivered', owner: { id: 7 }, route: { name: 'R1' }, price: 10, emitted_invoice: null },
      { id: 2, status: 'delivered', owner: { id: 7 }, route: { name: 'R1' }, price: 20, emitted_invoice: null },
    ];
    Object.assign(global.strapi, {
      contentType: () => ({ uid: ORDER, attributes: {} }),
      documents: () => ({ findFirst: async () => null }),
      service: () => ({ create: async () => ({ id: 100, code: 'ESBORRANY', total_base: 30 }) }),
    });
    global.strapi.db.query = (uid) => ({
      create: async ({ data }) => (uid === LOG ? logs.push(data) : data),
      findMany: async () => {
        if (uid === 'api::serie.serie') return [{ id: 16 }];
        if (uid === 'api::contact.contact') return [{ id: 9, name: 'Acme', users_permissions_user: { id: 7 } }];
        if (uid === ORDER) return orders;
        return [{ id: 3 }];
      },
      findOne: async () => ({ id: 30, name: 'P', project_phases: [{ id: 2, incomes: [] }] }),
    });
    global.strapi.db.connection = { raw: async () => ({}) };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });

    await ctrl.invoice({ request: { body: { orders: [1, 2], project: 30 } }, send: jest.fn() });

    expect(logs.map((l) => l.entity_id)).toEqual([1, 2]);
    expect(logs[0].changes).toEqual([
      { field: 'status', from: 'delivered', to: 'invoiced' },
      { field: 'emitted_invoice', from: null, to: { id: 100, label: 'ESBORRANY' } },
      { field: 'emitted_invoice_datetime', from: null, to: expect.any(String) },
    ]);
  });
});

describe('writes behind the document service (issues/119)', () => {
  // rows by id; findOne reads the current copy, `write` changes it the way a
  // db.query update would, running the subscriber around it
  let rows;
  let logs;
  const event = (where, data, result) => ({ model: { uid: ORDER }, params: { where, data }, state: {}, result });

  beforeEach(() => {
    rows = {
      42: { ...baseOrder() },
      43: { ...baseOrder(), id: 43, documentId: 'ord43', multidelivery_discount: '10.00' },
    };
    ({ logs } = mockStrapi());
    global.strapi.db.query = jest.fn((uid) =>
      uid === LOG
        ? { create: async ({ data }) => logs.push(data) }
        : {
            findOne: async ({ where }) => {
              const row = Object.values(rows).find((r) => r.id === where.id || r.documentId === where.documentId);
              return row ? JSON.parse(JSON.stringify(row)) : null;
            },
          },
    );
  });

  async function write(id, data) {
    const e = event({ id }, data);
    await changeLog.beforeRowUpdate(e);
    Object.assign(rows[id], data);
    await changeLog.afterRowUpdate(e);
  }

  it("records what a save's follow-up writes change on other orders, not on the saved one", async () => {
    await changeLog.changeLogMiddleware({ uid: ORDER, action: 'update', params: { documentId: 'ord42' } }, async () => {
      Object.assign(rows[42], { status: 'processed' }); // the document service's own write
      await write(42, { transfer: true, _internal: true }); // the saved order's own follow-up
      await write(43, { multidelivery_discount: 0, _internal: true }); // a sibling's discount
      return { id: 42 };
    });

    expect(logs.map((l) => [l.entity_id, l.changes])).toEqual([
      [42, [{ field: 'status', from: 'pending', to: 'processed' }]],
      [43, [{ field: 'multidelivery_discount', from: '10.00', to: 0 }]],
    ]);
    expect(logs[1]).toMatchObject({ entity: 'order', action: 'update', username: 'oficina' });
  });

  it('records a write made outside any order action right away (merging contacts)', async () => {
    await write(43, { comments: 'Nou punt' });
    expect(logs).toEqual([
      expect.objectContaining({ entity_id: 43, changes: [{ field: 'comments', from: null, to: 'Nou punt' }] }),
    ]);
  });

  it('adds nothing for a follow-up write that changes nothing', async () => {
    await write(43, { multidelivery_discount: 10, _internal: true });
    expect(logs).toEqual([]);
  });

  it('records the collection order a new order creates, and the new order once', async () => {
    rows[50] = { ...baseOrder(), id: 50, status: 'pending' };
    await changeLog.changeLogMiddleware({ uid: ORDER, action: 'create', params: { data: {} } }, async () => {
      await changeLog.afterRowCreate(event(undefined, { status: 'pending' }, { id: 42 })); // the order itself
      await changeLog.afterRowCreate(event(undefined, { is_collection_order: true, _internal: true }, { id: 50 }));
      return { id: 42 };
    });

    expect(logs.map((l) => [l.action, l.entity_id])).toEqual([
      ['create', 42],
      ['create', 50],
    ]);
  });
});
