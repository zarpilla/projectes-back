'use strict';

/**
 * 2026-10-31: «Modificable» on received documents (invoices, expenses,
 * incomes, tickets, diets, grants) was a one-way switch: once saved off,
 * every save was refused, including the one that would turn it back on.
 * PUT /api/document-unlock/:type/:id (admins only) turns it back on, and
 * clients can no longer send the internal `updatable_admin` bypass.
 * Emitted invoices no longer have «Modificable».
 */

const UID = 'api::received-invoice.received-invoice';

describe('PUT /api/document-unlock/:type/:id', () => {
  let rows;
  let tableUpdates;
  let logged;
  let controller;

  beforeEach(() => {
    jest.resetModules();
    rows = { [UID]: [{ id: 4, documentId: 'd4', updatable: false }, { id: 5, documentId: 'd5', updatable: true }] };
    tableUpdates = [];
    logged = [];
    jest.doMock('../src/services/change-log', () => ({
      isTracked: () => true,
      rowWith: async (uid, where) => ({ id: where.id, updatable: false }),
      logRawUpdate: async (uid, before, fields) => logged.push({ uid, id: before.id, fields }),
    }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) =>
            (rows[uid] || []).find((r) => (where.id ? r.id === where.id : r.documentId === where.documentId)) || null,
        }),
        metadata: { get: () => ({ tableName: 'received_invoices' }) },
        connection: (table) => ({
          where: (w) => ({ update: async (data) => tableUpdates.push({ table, id: w.id, ...data }) }),
        }),
      },
      log: { info() {} },
    };
    controller = require('../src/api/document-unlock/controllers/document-unlock.js')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ctx = (params) => ({
    params,
    state: { user: { id: 1 } },
    badRequest: jest.fn((m) => ({ status: 400, m })),
    notFound: jest.fn((m) => ({ status: 404, m })),
  });

  it('turns «Modificable» back on, straight in the table, and logs it', async () => {
    const result = await controller.unlock(ctx({ type: 'received-invoices', id: '4' }));
    expect(result).toEqual({ id: 4, updatable: true });
    expect(tableUpdates).toEqual([{ table: 'received_invoices', id: 4, updatable: true }]);
    expect(logged).toEqual([{ uid: UID, id: 4, fields: ['updatable'] }]);
  });

  it('finds the document by documentId too', async () => {
    await controller.unlock(ctx({ type: 'received-invoices', id: 'd4' }));
    expect(tableUpdates).toHaveLength(1);
  });

  it('writes nothing when the document is already modifiable', async () => {
    await controller.unlock(ctx({ type: 'received-invoices', id: '5' }));
    expect(tableUpdates).toEqual([]);
  });

  it('refuses emitted invoices and unknown types', async () => {
    const c = ctx({ type: 'emitted-invoices', id: '4' });
    await controller.unlock(c);
    expect(c.badRequest).toHaveBeenCalled();
    expect(tableUpdates).toEqual([]);
  });

  it('answers 404 for a missing document', async () => {
    const c = ctx({ type: 'received-invoices', id: '99' });
    await controller.unlock(c);
    expect(c.notFound).toHaveBeenCalled();
  });

  it('is for app admins only', () => {
    const { routes } = require('../src/api/document-unlock/routes/document-unlock.js');
    expect(routes).toEqual([expect.objectContaining({ method: 'PUT', config: { policies: ['global::isAdmin'] } })]);
  });
});

describe('strip-unlock-flag middleware', () => {
  it('drops updatable_admin from the body and from body.data', async () => {
    const middleware = require('../src/middlewares/strip-unlock-flag.js')();
    const ctx = { request: { body: { updatable_admin: true, data: { paid: true, updatable_admin: true } } } };
    const next = jest.fn();
    await middleware(ctx, next);
    expect(ctx.request.body).toEqual({ data: { paid: true } });
    expect(next).toHaveBeenCalled();
  });

  it('leaves bodies without it alone', async () => {
    const middleware = require('../src/middlewares/strip-unlock-flag.js')();
    const ctx = { request: { body: 'raw' } };
    await middleware(ctx, jest.fn());
    expect(ctx.request.body).toBe('raw');
  });

  it('is registered right after the body parser', () => {
    const list = require('../config/middlewares.js')({ env: { bool: () => false } });
    expect(list[list.indexOf('strapi::body') + 1]).toBe('global::strip-unlock-flag');
  });
});

describe('received documents keep «Modificable»', () => {
  beforeEach(() => jest.resetModules());

  it('still refuses saving one that is off', async () => {
    global.strapi = { db: { query: () => ({ findOne: async () => ({ id: 1, updatable: false }) }) } };
    const { createDocumentLifecycles } = require('../src/services/document-lifecycle');
    const lifecycles = createDocumentLifecycles({ uid: UID, entity: 'received-invoice', hasLines: true });
    await expect(lifecycles.beforeUpdate({ params: { where: { id: 1 }, data: { paid: true } } })).rejects.toThrow(
      'received-invoice NOT updatable',
    );
    delete global.strapi;
  });
});
