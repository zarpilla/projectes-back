'use strict';

/**
 * issues/161 (2026-10-18): the invoices' change log (issues/001) was written
 * but nobody could read it, status changes outside a save (sent by email,
 * VeriFactu, FACe) never reached it, a job's write was put on the last person
 * who saved the invoice, and the other documents had no history at all.
 * Performance reference: La Diligència invoices ~1000 La Dotzena orders a
 * month in ONE invoice, so a line edit stored both 1000-line lists and every
 * save of that invoice loaded and compared its lines twice.
 *
 * Guards: lines diffed line by line; an update that sends no lines does not
 * read them; incomes, expenses and quotes tracked; no author without a request
 * user; email, VeriFactu and FACe in the emitted invoice's history; the
 * history page endpoint; the lookup index.
 */

const fs = require('fs');
const path = require('path');

const EMITTED = 'api::emitted-invoice.emitted-invoice';
const LOG = 'api::document-change-log.document-change-log';
const CHAIN = 'api::verifactu-chain.verifactu-chain';
const FACE = 'api::face-queue.face-queue';

const ATTRIBUTES = {
  code: { type: 'string' },
  state: { type: 'enumeration' },
  total: { type: 'decimal' },
  paid_date: { type: 'date' },
  rectified_invoice: { type: 'relation', relation: 'oneToOne', target: EMITTED },
  user_last: { type: 'relation', relation: 'oneToOne', target: 'plugin::users-permissions.user' },
  lines: { type: 'component', repeatable: true, component: 'invoice-line.invoice-line' },
  contact_info: { type: 'component', repeatable: false, component: 'contact.contact-data' },
};

const line = (i, extra = {}) => ({ id: 1000 + i, concept: `Comanda ${i}`, base: 10, quantity: 1, vat: 21, ...extra });
const lines = (n) => Array.from({ length: n }, (_, i) => line(i + 1));

const invoice = (extra = {}) => ({ id: 7, code: 'F-0007', state: 'real', total: '12100.00', lines: lines(3), ...extra });

const DOCUMENT_UIDS = [
  EMITTED,
  'api::received-invoice.received-invoice',
  'api::received-income.received-income',
  'api::received-expense.received-expense',
  'api::quote.quote',
];

function mockStrapi({ rows = [], user = { id: 5, username: 'anna' }, query = {} } = {}) {
  const logs = [];
  const findOne = jest.fn(async () => (rows.length > 1 ? rows.shift() : rows[0]));
  const logQuery = {
    create: jest.fn(async ({ data }) => {
      logs.push(data);
      return data;
    }),
  };
  const contentTypes = {};
  for (const uid of DOCUMENT_UIDS) contentTypes[uid] = { attributes: ATTRIBUTES };
  global.strapi = {
    contentTypes,
    contentType: (uid) => ({ uid, kind: 'collectionType', attributes: ATTRIBUTES, options: {} }),
    db: {
      query: jest.fn((uid) => (uid === LOG ? logQuery : query[uid] || { findOne })),
      lifecycles: { subscribe: jest.fn() },
      connection: { raw: jest.fn(async () => [[], []]) },
    },
    requestContext: { get: () => (user ? { state: { user } } : undefined) },
    log: { error: jest.fn(), info: jest.fn() },
  };
  return { logs, findOne };
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

const update = (uid, data) =>
  changeLog.changeLogMiddleware({ uid, action: 'update', params: { documentId: 'doc7', data } }, async () => ({ id: 7 }));

describe('line changes, line by line (issues/161)', () => {
  it('a one-line edit of a 1000-line invoice stores that line only', async () => {
    const before = invoice({ lines: lines(1000) });
    const after = invoice({ lines: lines(1000).map((l, i) => (i === 499 ? { ...l, base: 12 } : { ...l, id: l.id + 5000 })) });
    const { logs } = mockStrapi({ rows: [before, after] });

    await update(EMITTED, { lines: [] });

    expect(logs).toHaveLength(1);
    const change = logs[0].changes.find((c) => c.field === 'lines');
    expect(change).toEqual({
      field: 'lines',
      from: 1000,
      to: 1000,
      lines: { added: [], removed: [], changed: [{ index: 500, changes: [{ field: 'base', from: 10, to: 12 }] }] },
    });
    // was ~2000 lines of JSON
    expect(JSON.stringify(logs[0].changes).length).toBeLessThan(500);
  });

  it('tells added and removed lines apart, and ignores lines that only moved', () => {
    const from = [{ c: 'A' }, { c: 'B' }, { c: 'C' }];
    expect(changeLog.listDiff(from, [{ c: 'C' }, { c: 'A' }, { c: 'B' }])).toBeNull();
    expect(changeLog.listDiff(from, [{ c: 'A' }, { c: 'C' }])).toEqual({
      added: [],
      removed: [{ index: 2, row: { c: 'B' } }],
      changed: [],
    });
    expect(changeLog.listDiff(from, [...from, { c: 'D' }])).toEqual({
      added: [{ index: 4, row: { c: 'D' } }],
      removed: [],
      changed: [],
    });
  });

  it('an update that sends no lines does not read them (paid date on the 1000-line invoice)', async () => {
    const { logs, findOne } = mockStrapi({
      rows: [invoice({ lines: undefined }), invoice({ lines: undefined, paid_date: '2026-10-18' })],
    });

    await update(EMITTED, { paid_date: '2026-10-18' });

    expect(findOne).toHaveBeenCalledTimes(2);
    for (const [{ populate }] of findOne.mock.calls) {
      expect(populate).not.toHaveProperty('lines');
      expect(populate).not.toHaveProperty('contact_info');
      // ignored fields are not read either
      expect(populate).not.toHaveProperty('user_last');
      expect(populate).toHaveProperty('rectified_invoice');
    }
    expect(logs[0].changes).toEqual([{ field: 'paid_date', from: null, to: '2026-10-18' }]);
  });

  it('an update that sends the lines reads and diffs them', async () => {
    const { findOne } = mockStrapi({ rows: [invoice(), invoice()] });
    await update(EMITTED, { lines: [] });
    expect(findOne.mock.calls[0][0].populate.lines).toBe(true);
  });
});

describe('VAT payment (raw UPDATE) reads only what it writes (issues/161)', () => {
  it('reads and compares just the VAT fields, not the lines', async () => {
    const before = { id: 7, code: 'F-0007', vat_paid_date: null, total: '1.00' };
    const after = { id: 7, code: 'F-0007', vat_paid_date: '2026-10-18T00:00:00.000Z', total: '2.00' };
    const { logs, findOne } = mockStrapi({ rows: [after] });
    global.strapi.contentTypes[EMITTED].attributes = { ...ATTRIBUTES, vat_paid_date: { type: 'datetime' } };

    await changeLog.logRawUpdate(EMITTED, before, ['vat_paid_date', 'deductible_vat_pct']);

    expect(findOne).toHaveBeenCalledWith({ where: { id: 7 }, populate: {} });
    // total moved too, but the VAT payment did not write it
    expect(logs[0].changes).toEqual([{ field: 'vat_paid_date', from: null, to: '2026-10-18T00:00:00.000Z' }]);
  });
});

describe('tracked documents and authors (issues/161)', () => {
  it.each([
    ['api::received-income.received-income', 'received-income'],
    ['api::received-expense.received-expense', 'received-expense'],
    ['api::quote.quote', 'quote'],
  ])('%s gets a history', async (uid, entity) => {
    const { logs } = mockStrapi({ rows: [invoice(), invoice({ total: '1.00' })] });
    await update(uid, {});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entity, entity_id: 7, action: 'update', username: 'anna' });
  });

  it('a write without a request user is nobody’s, not the last editor’s', async () => {
    const { logs } = mockStrapi({
      rows: [invoice({ user_last: { id: 9, username: 'last' } }), invoice({ total: '1.00', user_last: { id: 9 } })],
      user: null,
    });
    await update(EMITTED, {});
    expect(logs[0]).toMatchObject({ user_id: null, username: null });
  });
});

describe('VeriFactu and FACe statuses in the invoice history (issues/161)', () => {
  const chainRow = (state) => ({ id: 3, state, mode: 'real', emitted_invoice: { id: 7, code: 'F-0007' } });

  it('subscribes to the chain and the FACe queue', () => {
    mockStrapi();
    changeLog.registerSubmissionWrites();
    expect(global.strapi.db.lifecycles.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ models: [CHAIN, FACE] }),
    );
  });

  it('records the submission and each state it reaches, as the system', async () => {
    const reads = [chainRow('pending'), chainRow('pending'), chainRow('ko')];
    const chainQuery = { findOne: jest.fn(async () => reads.shift()) };
    const { logs } = mockStrapi({ user: null, query: { [CHAIN]: chainQuery } });
    const model = { uid: CHAIN };

    await changeLog.afterSubmissionCreate({ model, result: { id: 3 } });
    const event = { model, params: { where: { id: 3 }, data: { state: 'ko', _internal: true } }, state: {} };
    await changeLog.beforeSubmissionUpdate(event);
    await changeLog.afterSubmissionUpdate(event);

    expect(logs).toEqual([
      expect.objectContaining({
        entity: 'emitted-invoice',
        entity_id: 7,
        document_code: 'F-0007',
        action: 'verifactu',
        changes: [{ field: 'state', from: null, to: 'pending' }],
        details: { mode: 'real' },
        username: null,
      }),
      expect.objectContaining({ action: 'verifactu', changes: [{ field: 'state', from: 'pending', to: 'ko' }] }),
    ]);
  });

  it('does not read or record a write that leaves the status alone (QR, hash, last check)', async () => {
    const faceQuery = { findOne: jest.fn() };
    const { logs } = mockStrapi({ query: { [FACE]: faceQuery } });
    const event = { model: { uid: FACE }, params: { where: { id: 1 }, data: { last_status_check: new Date() } }, state: {} };

    await changeLog.beforeSubmissionUpdate(event);
    await changeLog.afterSubmissionUpdate(event);

    expect(faceQuery.findOne).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('keeps the FACe registration number', async () => {
    const row = (status, registration_number = null) => ({
      id: 1, status, mode: 'real', registration_number, emitted_invoice: { id: 7, code: 'F-0007' },
    });
    const reads = [row('pending'), row('registered', 'REG-1')];
    const { logs } = mockStrapi({ query: { [FACE]: { findOne: jest.fn(async () => reads.shift()) } } });
    const event = { model: { uid: FACE }, params: { where: { id: 1 }, data: { status: 'registered' } }, state: {} };

    await changeLog.beforeSubmissionUpdate(event);
    await changeLog.afterSubmissionUpdate(event);

    expect(logs[0]).toMatchObject({
      action: 'face',
      changes: [{ field: 'status', from: 'pending', to: 'registered' }],
      details: { mode: 'real', registration_number: 'REG-1' },
    });
  });
});

describe('sending an invoice by email (issues/161)', () => {
  const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

  it('marks the invoice as sent today and records who sent it to which address', async () => {
    const sent = { id: 7, code: 'F-0007', sent: false, sent_date: null, pdf: '/f.pdf', contact: { contact_email: 'client@example.org', name: 'Client' } };
    const { logs } = mockStrapi({ query: { [EMITTED]: { findOne: jest.fn(async () => sent) } } });
    const send = jest.fn(async () => ({}));
    global.strapi.plugin = () => ({ service: () => ({ send }) });
    global.strapi.documents = () => ({
      findFirst: async () => ({ invoice_email: 'us@example.org', invoice_subject: 'Factura {invoice_code}', invoice_template: '' }),
    });
    const realRead = fs.readFileSync;
    jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((file, ...rest) => (file === './public/f.pdf' ? Buffer.from('%PDF') : realRead(file, ...rest)));
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });

    const result = await ctrl.sendInvoiceByEmail({ params: { id: 7 }, send: jest.fn() });

    expect(result).toEqual({ done: true });
    const [sql, bindings] = global.strapi.db.connection.raw.mock.calls[0];
    expect(sql).toBe('UPDATE emitted_invoices SET sent = ?, sent_date = ? WHERE id = ?');
    expect(bindings[0]).toBe(true);
    expect(bindings[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bindings[2]).toBe(7);
    expect(logs).toEqual([
      expect.objectContaining({
        entity: 'emitted-invoice',
        entity_id: 7,
        action: 'email',
        details: { to: 'client@example.org' },
        changes: [
          { field: 'sent', from: false, to: true },
          { field: 'sent_date', from: null, to: bindings[1] },
        ],
        username: 'anna',
      }),
    ]);
  });
});

describe('GET /document-change-logs/history/:entity/:id (issues/161)', () => {
  const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'document-change-log', 'controllers', 'document-change-log.js');

  function setup(rows) {
    const logQuery = { findMany: jest.fn(async () => rows), count: jest.fn(async () => 120) };
    const emittedQuery = { findMany: jest.fn(async () => [{ id: 8, code: 'R-0001' }]) };
    mockStrapi();
    global.strapi.db.query = jest.fn((uid) => (uid === LOG ? logQuery : emittedQuery));
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    const ctx = (entity, id, query = {}) => ({ params: { entity, id }, query, badRequest: jest.fn(() => 400) });
    return { ctrl, ctx, logQuery, emittedQuery };
  }

  it('returns one page, compacting snapshots and big line changes', async () => {
    const changed = Array.from({ length: 80 }, (_, i) => ({ index: i + 1, changes: [] }));
    const { ctrl, ctx, logQuery } = setup([
      { id: 2, action: 'update', changes: [{ field: 'lines', from: 80, to: 80, lines: { added: [], removed: [], changed } }] },
      { id: 1, action: 'create', snapshot: { code: 'F-0007', lines: lines(1000) }, username: 'anna' },
    ]);

    const page = await ctrl.history(ctx('emitted-invoice', '7', { start: '50', limit: '500' }));

    expect(logQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entity: 'emitted-invoice', entity_id: 7 }, offset: 50, limit: 200 }),
    );
    expect(page.total).toBe(120);
    expect(page.entries[0].changes[0].lines.changed).toHaveLength(50);
    expect(page.entries[0].changes[0].lines.counts).toEqual({ added: 0, removed: 0, changed: 80 });
    expect(page.entries[1].snapshot).toEqual({ code: 'F-0007', lines: 1000 });
    expect(page.rectifiedBy).toEqual([{ id: 8, code: 'R-0001' }]);
  });

  it('refuses an entity that has no history and a bad id', async () => {
    const { ctrl, ctx } = setup([]);
    expect(await ctrl.history(ctx('project', '7'))).toBe(400);
    expect(await ctrl.history(ctx('quote', 'x'))).toBe(400);
  });

  it('only the emitted invoices look for their rectifications', async () => {
    const { ctrl, ctx, emittedQuery } = setup([]);
    const page = await ctrl.history(ctx('quote', '7'));
    expect(page).toEqual({ total: 120, entries: [] });
    expect(emittedQuery.findMany).not.toHaveBeenCalled();
  });

  it('is granted to the authenticated role, and only projects/admin pass the app permissions', () => {
    const rules = require('../src/services/app-access-rules');
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bootstrap-permissions.js'), 'utf8');
    expect(text).toMatch(/'document-change-log': \['find', 'findOne', 'history'\]/);
    const action = 'api::document-change-log.document-change-log.history';
    expect(rules.isAllowed(action, ['projects'])).toBe(true);
    expect(rules.isAllowed(action, ['admin'])).toBe(true);
    for (const permission of ['orders', 'orders_admin', 'orders_delivery', 'hours']) {
      expect(rules.isAllowed(action, [permission])).toBe(false);
    }
  });
});

describe('history lookup index (issues/161)', () => {
  const load = (client, existing) => {
    mockStrapi();
    global.strapi.db.dialect = { client };
    global.strapi.db.connection.raw = jest.fn(async (sql) => (sql.startsWith('SELECT') ? [existing, []] : [{}, {}]));
    return require('../src/services/ensure-change-log-index').ensureChangeLogIndex;
  };

  it('creates it on MySQL when missing, and leaves it alone when there', async () => {
    let ensure = load('mysql', []);
    await ensure();
    expect(global.strapi.db.connection.raw.mock.calls[1][0]).toBe(
      'CREATE INDEX document_change_logs_entity_idx ON document_change_logs (entity, entity_id, created_at)',
    );

    jest.resetModules();
    ensure = load('mysql', [{ name: 'document_change_logs_entity_idx' }]);
    await ensure();
    expect(global.strapi.db.connection.raw).toHaveBeenCalledTimes(1);
  });

  it('uses IF NOT EXISTS elsewhere', async () => {
    const ensure = load('sqlite', []);
    await ensure();
    expect(global.strapi.db.connection.raw.mock.calls[0][0]).toMatch(/^CREATE INDEX IF NOT EXISTS/);
  });
});
