'use strict';

/**
 * issues/415 (2026-11-06): ticking the validation check of a pending document
 * line in Tresoreria marks the document collected or paid on the date the
 * line shows (users asked for it: «quan tu facis el check manual, també es
 * marqués cobrada/pagada al document amb la data que posi al mòdul de
 * tresoreria»). Before, the check only stored a validation.
 *
 * Decided: a future date is refused (the screen asks for one); a document
 * expected later than it was paid moves its expected date and its project
 * lines to the payment date; a received invoice that is not «Modificable» can
 * be marked paid; unticking undoes only what the check did. With partial
 * payments (issues/412), the pending part becomes a new partial payment.
 */

const { memoryDb } = require('./helpers/memory-db');

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(async () => {}),
}));

const EMITTED = 'api::emitted-invoice.emitted-invoice';
const RECEIVED = 'api::received-invoice.received-invoice';
const INCOME_LINE = 'api::phase-income.phase-income';
const VALIDATION = 'api::treasury-validation.treasury-validation';
const TODAY = '2026-11-06';

describe('settleDocument / unsettle (issues/415)', () => {
  let db;
  let logged;
  let settle;

  beforeEach(() => {
    jest.resetModules();
    logged = [];
    jest.doMock('../src/services/change-log', () => ({
      isTracked: () => true,
      rowWith: async (uid, where, fields) => ({ id: where.id, fields }),
      logRawUpdate: async (uid, before, fields) => logged.push({ uid, id: before.id, fields }),
    }));
    db = memoryDb(
      {
        [EMITTED]: [
          { id: 10, code: 'F-10', state: 'real', total: 1210, paid: false, paid_date: null, emitted: '2026-10-01', paybefore: '2026-10-31', estimated_payment: null },
          { id: 11, code: 'F-11', state: 'real', total: 1000, paid: false, paid_date: null, emitted: '2026-10-01', paybefore: '2026-12-31', estimated_payment: '2026-12-15' },
          { id: 12, code: 'F-12', state: 'draft', total: 100, paid: false, emitted: '2026-10-01' },
          {
            id: 13,
            code: 'F-13',
            state: 'real',
            total: 1000,
            paid: false,
            paid_date: null,
            emitted: '2026-10-01',
            paybefore: '2026-10-31',
            partial_payments: [{ id: 'a1', date: '2026-10-05', amount: 400 }],
          },
          { id: 14, code: 'F-14', state: 'real', total: 500, paid: true, paid_date: '2026-10-02', emitted: '2026-10-01' },
        ],
        [RECEIVED]: [{ id: 30, code: 'R-30', total: 242, paid: false, paid_date: null, emitted: '2026-10-01', paybefore: '2026-10-20', updatable: false }],
        [INCOME_LINE]: [
          { id: 1, invoice: 11, date: '2026-12-15' },
          { id: 2, invoice: 11, date: '2026-11-01' },
        ],
        [VALIDATION]: [],
      },
      { tableNames: { [EMITTED]: 'emitted_invoices', [RECEIVED]: 'received_invoices' } },
    );
    global.strapi = { db };
    settle = require('../src/api/treasury-validation/services/settle');
  });

  afterEach(() => {
    delete global.strapi;
  });

  const doc = (uid, id) => db.rows[uid].find((r) => r.id === id);

  it('marks an unpaid invoice collected on the date and validates it', async () => {
    const r = await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 10, date: '2026-10-31', userId: 5, today: TODAY });
    expect(r).toEqual({ validation_key: 'emitted-invoices:10', paid: true, partial_payment_id: null });
    expect(doc(EMITTED, 10)).toMatchObject({ paid: true, paid_date: '2026-10-31', paybefore: '2026-10-31' });
    expect(db.rows[VALIDATION]).toEqual([
      expect.objectContaining({ entity_type: 'emitted-invoices', entity_id: 10, sub_type: null, validated_by: 5 }),
    ]);
    // in the invoice's «Historial»
    expect(logged).toEqual([{ uid: EMITTED, id: 10, fields: ['paid', 'paid_date'] }]);
  });

  it('marks paid a received invoice that is not «Modificable»', async () => {
    await settle.settleDocument({ entity_type: 'received-invoices', entity_id: 30, date: '2026-10-20', today: TODAY });
    expect(doc(RECEIVED, 30)).toMatchObject({ paid: true, paid_date: '2026-10-20' });
  });

  it('moves the expected date and the project lines when paid before it was expected', async () => {
    await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 11, date: '2026-11-05', today: TODAY });
    expect(doc(EMITTED, 11)).toMatchObject({ paid: true, paid_date: '2026-11-05', estimated_payment: '2026-11-05', paybefore: '2026-11-05' });
    expect(db.rows[INCOME_LINE].map((l) => l.date)).toEqual(['2026-11-05', '2026-11-05']);
  });

  it('refuses a future date, a draft and a paid document, and changes nothing', async () => {
    await expect(
      settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 11, date: '2026-12-15', today: TODAY }),
    ).rejects.toThrow(/no pot ser futura/);
    await expect(settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 12, date: '2026-10-01', today: TODAY })).rejects.toThrow(
      /esborrany/,
    );
    await expect(settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 14, date: '2026-10-01', today: TODAY })).rejects.toThrow(
      /ja està cobrat/,
    );
    await expect(settle.settleDocument({ entity_type: 'payrolls', entity_id: 1, date: '2026-10-01', today: TODAY })).rejects.toThrow(
      /documents/,
    );
    expect(db.raw).toEqual([]);
    expect(db.rows[VALIDATION]).toEqual([]);
  });

  it('adds the pending part of a partly collected invoice as a partial payment, validated on its own', async () => {
    const r = await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 13, date: '2026-10-30', today: TODAY });
    expect(r.validation_key).toBe(`emitted-invoices:13:payment-${r.partial_payment_id}`);
    const stored = doc(EMITTED, 13);
    expect(JSON.parse(stored.partial_payments)).toEqual([
      { id: 'a1', date: '2026-10-05', amount: 400 },
      { id: r.partial_payment_id, date: '2026-10-30', amount: 600 },
    ]);
    expect(stored).toMatchObject({ paid: true, paid_date: '2026-10-30' });
  });

  it('collects part of an invoice (a bank movement for less), leaving it pending', async () => {
    const r = await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 10, date: '2026-10-20', amount: 200, today: TODAY });
    expect(r.paid).toBe(false);
    expect(JSON.parse(doc(EMITTED, 10).partial_payments)).toEqual([{ id: r.partial_payment_id, date: '2026-10-20', amount: 200 }]);
    await expect(
      settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 10, date: '2026-10-20', amount: 2000, today: TODAY }),
    ).rejects.toThrow(/no pot superar/);
  });

  it('pays part of a received invoice from a bank charge (negative amount, positive total)', async () => {
    const r = await settle.settleDocument({ entity_type: 'received-invoices', entity_id: 30, date: '2026-10-20', amount: -100, today: TODAY });
    expect(r.paid).toBe(false);
    expect(JSON.parse(doc(RECEIVED, 30).partial_payments)).toEqual([{ id: r.partial_payment_id, date: '2026-10-20', amount: 100 }]);
    await expect(
      settle.settleDocument({ entity_type: 'received-invoices', entity_id: 30, date: '2026-10-21', amount: -500, today: TODAY }),
    ).rejects.toThrow(/no pot superar el que queda pendent de «R-30» \(142.00 €\)/);
  });

  it('unticking puts the document, its expected date and its lines back', async () => {
    await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 11, date: '2026-11-05', today: TODAY });
    const v = db.rows[VALIDATION][0];
    expect(await settle.unsettle(v)).toBe(true);
    expect(doc(EMITTED, 11)).toMatchObject({ paid: false, paid_date: null, estimated_payment: '2026-12-15', paybefore: '2026-12-31' });
    expect(db.rows[INCOME_LINE].map((l) => l.date)).toEqual(['2026-12-15', '2026-11-01']);
  });

  it('unticking removes only the partial payment the check added', async () => {
    await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 13, date: '2026-10-30', today: TODAY });
    expect(await settle.unsettle(db.rows[VALIDATION][0])).toBe(true);
    const stored = doc(EMITTED, 13);
    expect(JSON.parse(stored.partial_payments)).toEqual([{ id: 'a1', date: '2026-10-05', amount: 400 }]);
    expect(stored).toMatchObject({ paid: false, paid_date: null });
  });

  it('leaves a document changed by hand since: only the validation goes', async () => {
    await settle.settleDocument({ entity_type: 'emitted-invoices', entity_id: 10, date: '2026-10-31', today: TODAY });
    doc(EMITTED, 10).paid_date = '2026-10-29';
    expect(await settle.unsettle(db.rows[VALIDATION][0])).toBe(false);
    expect(doc(EMITTED, 10)).toMatchObject({ paid: true, paid_date: '2026-10-29' });
    // a validation without settlement (ticked on a paid line) changes nothing
    expect(await settle.unsettle({ entity_type: 'emitted-invoices', entity_id: 14 })).toBe(false);
  });
});

describe('treasury-validation controller (issues/415)', () => {
  let db;
  let controller;
  const unsettle = jest.fn(async () => true);
  const releaseMovement = jest.fn(async () => {});

  beforeEach(() => {
    jest.resetModules();
    unsettle.mockClear();
    releaseMovement.mockClear();
    jest.doMock('../src/api/treasury-validation/services/settle', () => ({
      ...jest.requireActual('../src/api/treasury-validation/services/settle'),
      unsettle,
    }));
    jest.doMock('../src/api/bank-movement/services/reconcile', () => ({ releaseMovement }));
    db = memoryDb(
      {
        [VALIDATION]: [{ id: 1, entity_type: 'emitted-invoices', entity_id: 10, sub_type: null, settlement: { date: '2026-10-31' }, bank_movement: 7 }],
        'api::bank-movement.bank-movement': [{ id: 7 }],
      },
      { refs: { [VALIDATION]: { bank_movement: 'api::bank-movement.bank-movement' } } },
    );
    global.strapi = { db };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    controller = require('../src/api/treasury-validation/controllers/treasury-validation');
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('unticking a validation that marked its document paid puts it back, and frees its bank movement', async () => {
    const r = await controller.toggle({ request: { body: { entity_type: 'emitted-invoices', entity_id: 10 } }, state: { user: { id: 1 } } });
    expect(r).toMatchObject({ validated: false, reverted: true });
    expect(unsettle).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(releaseMovement).toHaveBeenCalledWith(7);
    expect(db.rows[VALIDATION]).toEqual([]);
  });

  it('settle answers 400 with the reason it refused', async () => {
    const ctx = { request: { body: { entity_type: 'emitted-invoices', entity_id: 10, date: '2999-01-01' } }, state: { user: { id: 1 } }, badRequest: jest.fn((m) => m) };
    await controller.settle(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith('La data de cobrament o pagament no pot ser futura');
  });
});

describe('Tresoreria rows carry what the check settles (issues/415)', () => {
  const { treasuryDb } = require('./helpers/treasury-db');
  const year = 2025;

  async function forecast(rows) {
    jest.resetModules();
    jest.doMock('../src/services/me-settings', () => ({
      getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
    }));
    global.strapi = {
      db: {
        ...treasuryDb(),
        query: (uid) => ({ findMany: async () => rows[uid] || [], findOne: async () => null, count: async () => 0 }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    const ctx = { query: { _limit: '-1', year: String(year), periodification: 'no', project_likelihoods: 'null' }, state: { user: { id: 1 } } };
    ctx.request = { query: ctx.query };
    return (await actions.forecast(ctx)).treasury;
  }

  afterEach(() => {
    delete global.strapi;
  });

  it('on unpaid documents and on what is pending of a partly paid one, never on drafts or paid ones', async () => {
    const treasury = await forecast({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::emitted-invoice.emitted-invoice': [
        { id: 1, code: 'F1', state: 'real', emitted: `${year}-02-01`, total: 121, total_vat: 21, paid: false, projects: [], contact: { name: 'Clienta', nif: 'B1' } },
        { id: 2, code: 'F2', state: 'draft', emitted: `${year}-02-01`, total: 50, paid: false, projects: [] },
        { id: 3, code: 'F3', state: 'real', emitted: `${year}-02-01`, total: 80, paid: true, paid_date: `${year}-02-10`, projects: [] },
        {
          id: 4,
          code: 'F4',
          state: 'real',
          emitted: `${year}-02-01`,
          total: 100,
          paid: false,
          projects: [],
          partial_payments: [{ id: 'p1', date: `${year}-02-05`, amount: 40 }],
        },
      ],
      'api::received-expense.received-expense': [
        { id: 6, code: 'D6', emitted: `${year}-01-05`, total: 30, paid: false, projects: [], document_type: { id: 2, name: 'Tiquet' } },
      ],
    });
    const settleOf = (concept) => treasury.filter((t) => t.concept === concept).map((t) => t.settle || null);
    expect(settleOf('F1')).toEqual([{ kind: 'emitted-invoices', id: 1 }]);
    expect(settleOf('F2')).toEqual([null]);
    expect(settleOf('F3')).toEqual([null]);
    const f4 = treasury.filter((t) => t.concept === 'F4');
    expect(f4.find((t) => t.type === 'Factura cobrada (parcial)').settle).toBeUndefined();
    expect(f4.find((t) => t.type === 'Factura emesa (pendent)').settle).toEqual({ kind: 'emitted-invoices', id: 4 });
    expect(settleOf('D6')).toEqual([{ kind: 'received-expenses', id: 6 }]);
    expect(treasury.find((t) => t.concept === 'F1').contact_nif).toBe('B1');
  });
});
