'use strict';

/**
 * issues/001 (2026-10-08): emitted and received invoices had no change log, so
 * once the payment method (and anything else) could be corrected after
 * emission nobody could tell who changed what. Every create, update and delete
 * now writes an api::document-change-log row: user, entity, field, old -> new.
 *
 * Guards: the diff sees the lines as they were BEFORE the save (taken around
 * the document action, not in beforeUpdate, where v5 has already rewritten the
 * component rows); bookkeeping-only saves (pdf regeneration) log nothing; a
 * failing log never fails the write.
 */

const EMITTED = 'api::emitted-invoice.emitted-invoice';
const RECEIVED = 'api::received-invoice.received-invoice';
const LOG = 'api::document-change-log.document-change-log';

const ATTRIBUTES = {
  code: { type: 'string' },
  state: { type: 'enumeration' },
  total: { type: 'decimal' },
  paid: { type: 'boolean' },
  pdf: { type: 'string' },
  updatedAt: { type: 'datetime' },
  payment_method: { type: 'relation', relation: 'oneToOne', target: 'api::payment-method.payment-method' },
  projects: { type: 'relation', relation: 'manyToMany', target: 'api::project.project' },
  user_last: { type: 'relation', relation: 'oneToOne', target: 'plugin::users-permissions.user' },
  lines: { type: 'component', repeatable: true, component: 'invoice-line.invoice-line' },
};

const baseRow = () => ({
  id: 7,
  documentId: 'doc7',
  code: 'F-0007',
  state: 'real',
  total: '121.00',
  paid: false,
  pdf: '/uploads/a.pdf',
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  payment_method: { id: 1, name: 'Banc A' },
  projects: [{ id: 3, name: 'P3' }],
  user_last: { id: 9, username: 'last-editor' },
  lines: [{ id: 100, concept: 'Hores', base: 100, quantity: 1, vat: 21 }],
});

/**
 * @param {object[]} rows successive results of findOne on the document (before, after, …)
 */
function mockStrapi({ rows = [], user = { id: 5, username: 'anna' }, failLog = false } = {}) {
  const logs = [];
  const docQuery = { findOne: jest.fn(async () => (rows.length > 1 ? rows.shift() : rows[0])) };
  const logQuery = {
    create: jest.fn(async ({ data }) => {
      if (failLog) throw new Error('db down');
      logs.push(data);
      return data;
    }),
  };
  global.strapi = {
    contentTypes: { [EMITTED]: { attributes: ATTRIBUTES }, [RECEIVED]: { attributes: ATTRIBUTES } },
    db: { query: jest.fn((uid) => (uid === LOG ? logQuery : docQuery)) },
    requestContext: { get: () => (user ? { state: { user } } : undefined) },
    log: { error: jest.fn() },
  };
  return { logs, docQuery };
}

let changeLog;

beforeEach(() => {
  jest.resetModules();
  changeLog = require('../src/services/change-log');
});

afterEach(() => {
  delete global.strapi;
});

describe('document change log (issues/001)', () => {
  it('logs a payment method change with who, old and new value', async () => {
    const before = baseRow();
    const after = { ...baseRow(), payment_method: { id: 2, name: 'Banc B' } };
    const { logs } = mockStrapi({ rows: [before, after] });

    const next = jest.fn(async () => ({ id: 7 }));
    await changeLog.changeLogMiddleware(
      { uid: EMITTED, action: 'update', params: { documentId: 'doc7', data: {} } },
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      entity: 'emitted-invoice',
      entity_id: 7,
      document_code: 'F-0007',
      action: 'update',
      user_id: 5,
      username: 'anna',
      changes: [
        { field: 'payment_method', from: { id: 1, label: 'Banc A' }, to: { id: 2, label: 'Banc B' } },
      ],
    });
  });

  it('diffs the lines and ignores the component row ids being re-created', async () => {
    const before = baseRow();
    const after = {
      ...baseRow(),
      total: 242,
      lines: [{ id: 200, concept: 'Hores', base: 100, quantity: 2, vat: 21 }],
    };
    const { logs } = mockStrapi({ rows: [before, after] });

    await changeLog.changeLogMiddleware(
      { uid: RECEIVED, action: 'update', params: { documentId: 'doc7' } },
      async () => ({ id: 7 }),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0].entity).toBe('received-invoice');
    expect(logs[0].changes.map((c) => c.field).sort()).toEqual(['lines', 'total']);
    const lines = logs[0].changes.find((c) => c.field === 'lines');
    expect(lines.from).toEqual([{ concept: 'Hores', base: 100, quantity: 1, vat: 21 }]);
    expect(lines.to).toEqual([{ concept: 'Hores', base: 100, quantity: 2, vat: 21 }]);
  });

  it('logs nothing when only bookkeeping fields moved (pdf regeneration, updatedAt, ids)', async () => {
    const before = baseRow();
    const after = {
      ...baseRow(),
      total: 121, // '121.00' from one query, 121 from another
      pdf: '/uploads/b.pdf',
      updatedAt: new Date(),
      lines: [{ id: 300, concept: 'Hores', base: 100, quantity: 1, vat: 21 }],
    };
    const { logs } = mockStrapi({ rows: [before, after] });

    await changeLog.changeLogMiddleware(
      { uid: EMITTED, action: 'update', params: { documentId: 'doc7' } },
      async () => ({ id: 7 }),
    );

    expect(logs).toHaveLength(0);
  });

  it('logs creation and deletion with a snapshot of the document', async () => {
    const row = baseRow();
    const { logs } = mockStrapi({ rows: [row] });

    await changeLog.changeLogMiddleware({ uid: EMITTED, action: 'create', params: { data: {} } }, async () => ({
      id: 7,
    }));
    await changeLog.changeLogMiddleware(
      { uid: EMITTED, action: 'delete', params: { documentId: 'doc7' } },
      async () => ({ documentId: 'doc7' }),
    );

    expect(logs.map((l) => l.action)).toEqual(['create', 'delete']);
    for (const log of logs) {
      expect(log.snapshot).toMatchObject({ code: 'F-0007', payment_method: { id: 1, label: 'Banc A' } });
      expect(log.snapshot).not.toHaveProperty('pdf');
    }
  });

  it('falls back to user_last when there is no request user', async () => {
    const before = baseRow();
    const after = { ...baseRow(), paid: true };
    const { logs } = mockStrapi({ rows: [before, after], user: null });

    await changeLog.changeLogMiddleware(
      { uid: EMITTED, action: 'update', params: { documentId: 'doc7' } },
      async () => ({ id: 7 }),
    );

    expect(logs[0]).toMatchObject({ user_id: 9, username: 'last-editor' });
  });

  it('never fails the write when the log cannot be stored', async () => {
    const before = baseRow();
    const after = { ...baseRow(), paid: true };
    mockStrapi({ rows: [before, after], failLog: true });

    const result = await changeLog.changeLogMiddleware(
      { uid: EMITTED, action: 'update', params: { documentId: 'doc7' } },
      async () => ({ id: 7, ok: true }),
    );

    expect(result).toEqual({ id: 7, ok: true });
    expect(global.strapi.log.error).toHaveBeenCalled();
  });

  it('leaves other content types and read actions alone', async () => {
    const { docQuery } = mockStrapi({ rows: [baseRow()] });
    const next = jest.fn(async () => 'ok');

    await changeLog.changeLogMiddleware({ uid: 'api::quote.quote', action: 'update', params: {} }, next);
    await changeLog.changeLogMiddleware({ uid: EMITTED, action: 'findMany', params: {} }, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(docQuery.findOne).not.toHaveBeenCalled();
  });

  it('logs raw-SQL writes made outside the document service (VAT payment)', async () => {
    const before = baseRow();
    const after = { ...baseRow(), vat_paid_date: '2026-10-08T00:00:00.000Z' };
    const { logs } = mockStrapi({ rows: [after] });
    global.strapi.contentTypes[EMITTED].attributes = { ...ATTRIBUTES, vat_paid_date: { type: 'datetime' } };

    await changeLog.logRawUpdate(EMITTED, before);

    expect(logs).toHaveLength(1);
    expect(logs[0].changes).toEqual([{ field: 'vat_paid_date', from: null, to: '2026-10-08T00:00:00.000Z' }]);
  });

  it('is registered as a document-service middleware on boot', () => {
    const use = jest.fn();
    const app = require('../src/index');
    app.register({ strapi: { documents: { use } } });
    expect(use).toHaveBeenCalledWith(require('../src/services/change-log').changeLogMiddleware);
  });
});
