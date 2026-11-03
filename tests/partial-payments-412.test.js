'use strict';

/**
 * issues/412 (2026-11-03): an invoice or other income is sometimes collected
 * in several goes, and an expense paid in instalments. A document only had one
 * `paid` + `paid_date`, so it was either fully collected on one date or
 * pending, in Tresoreria and in Previsió econòmica too.
 *
 * Now `partial_payments` lists them ({ id, date, amount }): `paid` /
 * `paid_date` follow from the list, they can't add up to more than the total,
 * Tresoreria shows one executed movement per partial payment (validated on its
 * own) and what is still pending on the expected date.
 */

const moment = require('moment');
const { treasuryDb } = require('./helpers/treasury-db');

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));
jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const UID = 'api::received-invoice.received-invoice';

describe('applyPartialPayments', () => {
  const { applyPartialPayments } = require('../src/services/partial-payments');

  it('marks the document paid only once the payments reach the total, on the last date', () => {
    const data = { total: 1000, partial_payments: [{ date: '2026-03-01', amount: 600 }] };
    applyPartialPayments(data);
    expect(data.paid).toBe(false);
    expect(data.paid_date).toBeNull();
    expect(data.partial_payments[0]).toEqual({ id: expect.any(String), date: '2026-03-01', amount: 600 });

    const id = data.partial_payments[0].id;
    const full = { total: 1000, partial_payments: [...data.partial_payments, { date: '2026-04-15', amount: 400 }] };
    applyPartialPayments(full);
    expect(full.paid).toBe(true);
    expect(full.paid_date).toBe('2026-04-15');
    expect(full.partial_payments[0].id).toBe(id);
  });

  it('refuses payments that add up to more than the total', () => {
    const data = {
      total: 1000,
      partial_payments: [
        { date: '2026-03-01', amount: 600 },
        { date: '2026-04-01', amount: 400.02 },
      ],
    };
    expect(() => applyPartialPayments(data)).toThrow(/no poden superar el total/);
  });

  it('checks the stored payments when the total goes down', () => {
    const existing = { total: 1000, partial_payments: [{ id: 'a1', date: '2026-03-01', amount: 900 }] };
    expect(() => applyPartialPayments({ total: 800 }, existing)).toThrow(/no poden superar/);
  });

  it('refuses an entry without a date or an amount', () => {
    expect(() => applyPartialPayments({ total: 10, partial_payments: [{ amount: 5 }] })).toThrow(/data/);
    expect(() => applyPartialPayments({ total: 10, partial_payments: [{ date: '2026-01-01', amount: 0 }] })).toThrow(
      /import/,
    );
  });

  it('leaves paid / paid_date alone without payments, and an empty list clears the field', () => {
    const data = { total: 50, paid: true, paid_date: '2026-01-02', partial_payments: [] };
    applyPartialPayments(data);
    expect(data).toEqual({ total: 50, paid: true, paid_date: '2026-01-02', partial_payments: null });
  });

  it('works with a credit note (negative total)', () => {
    const data = { total: -200, partial_payments: [{ date: '2026-05-01', amount: -200 }] };
    applyPartialPayments(data);
    expect(data.paid).toBe(true);
  });

  it('refuses payments on a document whose total is 0, saying so', () => {
    expect(() => applyPartialPayments({ total: 0, partial_payments: [{ date: '2026-05-01', amount: 10 }] })).toThrow(
      /total 0/,
    );
  });
});

describe('received-* document lifecycle', () => {
  const { createDocumentLifecycles } = require('../src/services/document-lifecycle');
  const lifecycles = createDocumentLifecycles({
    uid: UID,
    entity: 'received-invoice',
    hasLines: true,
    withPartialPayments: true,
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('derives paid from the payments on update and refuses an overpayment', async () => {
    const existing = { id: 1, updatable: true, total: 300 };
    global.strapi = { db: { query: () => ({ findOne: async () => existing, findMany: async () => [] }) } };

    const data = { partial_payments: [{ date: '2026-02-01', amount: 100 }] };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data.paid).toBe(false);

    const over = { partial_payments: [{ date: '2026-02-01', amount: 301 }] };
    await expect(lifecycles.beforeUpdate({ params: { where: { id: 1 }, data: over } })).rejects.toThrow(
      /no poden superar/,
    );
  });
});

describe('Tresoreria', () => {
  const year = moment().year() - 1;

  function stubStrapi(rows) {
    global.strapi = {
      db: {
        ...treasuryDb(),
        query: (uid) => ({
          findMany: async () => rows[uid] || [],
          findOne: async () => null,
          count: async () => 0,
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
  }

  async function forecast() {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const ctx = {
      query: { _limit: '-1', year: String(year), periodification: 'no', project_likelihoods: 'null' },
      state: { user: { id: 20 } },
      send(body) {
        this.body = body;
      },
    };
    ctx.request = { query: ctx.query };
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    return (await actions.forecast(ctx)) || ctx.body;
  }

  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::treasury-validation.treasury-validation': [
        { entity_type: 'emitted-invoices', entity_id: 1, sub_type: 'payment-p1' },
        // validated as a whole before it was split: says nothing of what is pending
        { entity_type: 'emitted-invoices', entity_id: 1, sub_type: null },
      ],
      'api::emitted-invoice.emitted-invoice': [
        {
          id: 1,
          code: 'F1',
          state: 'real',
          emitted: `${year}-02-01`,
          paybefore: `${year}-03-01`,
          total_base: 1000,
          total_vat: 210,
          total: 1210,
          paid: false,
          projects: [],
          partial_payments: [
            { id: 'p2', date: `${year}-04-10`, amount: 300 },
            { id: 'p1', date: `${year}-02-20`, amount: 605 },
          ],
        },
        { id: 2, code: 'F2', state: 'real', emitted: `${year}-02-02`, total: 121, total_vat: 21, projects: [] },
      ],
      'api::received-income.received-income': [
        {
          id: 5,
          code: 'I5',
          emitted: `${year}-02-01`,
          paybefore: `${year}-07-31`,
          total: 1100,
          total_vat: 100,
          paid: false,
          projects: [],
          document_type: { id: 1, name: 'Subvenció' },
          partial_payments: [{ id: 'g1', date: `${year}-03-15`, amount: 440 }],
        },
      ],
      'api::received-expense.received-expense': [
        {
          id: 6,
          code: 'D6',
          emitted: `${year}-01-05`,
          paybefore: `${year}-09-30`,
          total: 242,
          total_vat: 42,
          paid: false,
          projects: [],
          document_type: { id: 2, name: 'Lloguer' },
          partial_payments: [{ id: 'h1', date: `${year}-02-05`, amount: 121 }],
        },
      ],
      'api::received-invoice.received-invoice': [
        {
          id: 3,
          code: 'R3',
          emitted: `${year}-01-10`,
          paybefore: `${year}-06-30`,
          total: 500,
          total_vat: 0,
          paid: true,
          paid_date: `${year}-05-01`,
          projects: [],
          partial_payments: [
            { id: 'q1', date: `${year}-01-31`, amount: 250 },
            { id: 'q2', date: `${year}-05-01`, amount: 250 },
          ],
        },
        {
          id: 4,
          code: 'R4',
          emitted: `${year}-01-10`,
          paybefore: `${year}-06-30`,
          total: 400,
          total_vat: 0,
          paid: false,
          updatable: false,
          projects: [],
          partial_payments: [{ id: 'r1', date: `${year}-02-10`, amount: 100 }],
        },
      ],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const day = (t) => moment(t.date).format('YYYY-MM-DD');

  it('shows each partial collection on its date and the rest pending on the expected date', async () => {
    const { treasury } = await forecast();
    // in date order, as Tresoreria lists them
    const rows = treasury.filter((t) => t.concept === 'F1');
    expect(rows.map((t) => [t.type, day(t), t.total_amount, t.paid])).toEqual([
      ['Factura cobrada (parcial)', `${year}-02-20`, 605, true],
      ['Factura emesa (pendent)', `${year}-03-01`, 305, false],
      ['Factura cobrada (parcial)', `${year}-04-10`, 300, true],
    ]);
    // each one with its share of the VAT
    expect(rows.map((t) => t.signed_vat)).toEqual([105, expect.closeTo(52.93, 2), expect.closeTo(52.07, 2)]);
    // only the pending part can be moved to another date
    expect(rows.map((t) => t.date_edit)).toEqual([null, 'emitted-invoices', null]);
  });

  it('does not take the whole-document validation for the pending part', async () => {
    const { treasury } = await forecast();
    const pending = treasury.find((t) => t.concept === 'F1' && !t.paid);
    expect([pending.validation_key, pending.is_validated]).toEqual([null, false]);
  });

  it('keeps the pending date fixed while the document is not «Modificable»', async () => {
    const { treasury } = await forecast();
    expect(treasury.filter((t) => t.concept === 'R4').map((t) => [t.type, t.total_amount, t.date_edit])).toEqual([
      ['Factura pagada (parcial)', -100, null],
      ['Factura rebuda (pendent)', -300, null],
    ]);
  });

  it('splits other incomes and other expenses too, with their type and VAT share', async () => {
    const { treasury } = await forecast();
    const rows = (code) =>
      treasury.filter((t) => t.concept === code).map((t) => [t.type, day(t), t.total_amount, t.signed_vat]);
    expect(rows('I5')).toEqual([
      ['Ingrés cobrat (parcial, Subvenció)', `${year}-03-15`, 440, 40],
      ['Ingrés emès (pendent, Subvenció)', `${year}-07-31`, 660, 60],
    ]);
    expect(rows('D6')).toEqual([
      ['Despesa pagada (parcial, Lloguer)', `${year}-02-05`, -121, -21],
      ['Despesa rebuda (pendent, Lloguer)', `${year}-09-30`, -121, -21],
    ]);
  });

  it('validates each partial collection on its own', async () => {
    const { treasury } = await forecast();
    const rows = treasury.filter((t) => t.concept === 'F1' && t.paid);
    expect(rows.map((t) => [t.validation_key, t.is_validated])).toEqual([
      ['emitted-invoices:1:payment-p1', true],
      ['emitted-invoices:1:payment-p2', false],
    ]);
  });

  it('keeps a document without partial payments as one movement', async () => {
    const { treasury } = await forecast();
    expect(treasury.filter((t) => t.concept === 'F2').map((t) => [t.type, t.total_amount])).toEqual([
      ['Factura emesa', 121],
    ]);
  });

  it('splits an expense paid in instalments, with nothing left pending', async () => {
    const { treasury } = await forecast();
    expect(treasury.filter((t) => t.concept === 'R3').map((t) => [t.type, day(t), t.total_amount])).toEqual([
      ['Factura pagada (parcial)', `${year}-01-31`, -250],
      ['Factura pagada (parcial)', `${year}-05-01`, -250],
    ]);
  });
});

describe('treasury validation of a partial payment', () => {
  afterEach(() => {
    delete global.strapi;
  });

  async function toggle(sub_type) {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const create = jest.fn(async () => ({}));
    global.strapi = { db: { query: () => ({ findOne: async () => null, create }) } };
    const build = require('../src/api/treasury-validation/controllers/treasury-validation.js');
    const actions = build({ strapi: global.strapi });
    const ctx = {
      request: { body: { entity_type: 'emitted-invoices', entity_id: 1, sub_type } },
      state: { user: { id: 20 } },
      badRequest: jest.fn((m) => ({ error: m })),
    };
    return { result: await actions.toggle(ctx), create, ctx };
  }

  it('accepts payment-<id> and refuses other sub types', async () => {
    const ok = await toggle('payment-p1');
    expect(ok.result).toEqual({ validated: true, message: 'Movement validated' });
    expect(ok.create.mock.calls[0][0].data.sub_type).toBe('payment-p1');

    const bad = await toggle('payment:1');
    expect(bad.ctx.badRequest).toHaveBeenCalled();
    expect(bad.create).not.toHaveBeenCalled();
  });
});
