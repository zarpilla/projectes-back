'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/370 (2026-10-30) — Tresoreria › Moviments bancaris: the dates of the
 * pending movements can be changed there, and the project lines follow. Only
 * what isn't paid or collected moves: an expected line («Previsió pag.»), or
 * an unpaid document («Previsió cobrament» and «Venciment» of incomes,
 * «Venciment» of expenses) with the lines it is assigned to. Anything paid refuses the whole
 * save.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: {} }),
}));

const TABLES = {
  'api::emitted-invoice.emitted-invoice': 'emitted_invoices',
  'api::received-invoice.received-invoice': 'received_invoices',
  'api::received-income.received-income': 'received_incomes',
  'api::received-expense.received-expense': 'received_expenses',
};

describe('updateMovementDates (issues/370)', () => {
  let rows;
  let queryUpdates;
  let tableUpdates;
  let updateMovementDates;

  beforeEach(() => {
    jest.resetModules();
    rows = {
      'api::phase-income.phase-income': [
        { id: 1, concept: 'Pendent', paid: false, date: '2026-11-01' },
        { id: 2, concept: 'Assignada', paid: true, date: '2026-11-01', invoice: 10 },
        { id: 3, concept: 'Assignada igual', paid: true, date: '2026-12-15', invoice: 10 },
      ],
      'api::phase-expense.phase-expense': [{ id: 5, concept: 'Despesa', paid: true, date: '2026-11-01', invoice: 30 }],
      'api::emitted-invoice.emitted-invoice': [
        { id: 10, code: 'F-10', paid: false, paid_date: null },
        { id: 11, code: 'F-11', paid: true, paid_date: '2026-10-01' },
        { id: 12, code: 'F-12', paid: false, paid_date: '2026-10-02' },
      ],
      'api::received-invoice.received-invoice': [{ id: 30, code: 'R-30', paid: false }],
    };
    queryUpdates = [];
    tableUpdates = [];
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) => (rows[uid] || []).find((r) => r.id === where.id) || null,
          findMany: async ({ where }) => {
            const [relation, cond] = Object.entries(where)[0];
            return (rows[uid] || []).filter((r) => r[relation] === cond.id);
          },
          update: async ({ where, data }) => queryUpdates.push({ uid, id: where.id, ...data }),
        }),
        metadata: { get: (uid) => ({ tableName: TABLES[uid] }) },
        connection: (table) => ({
          where: (w) => ({ update: async (data) => tableUpdates.push({ table, id: w.id, ...data }) }),
        }),
      },
    };
    ({ updateMovementDates } = require('../src/api/treasury/services/movement-dates'));
  });

  afterEach(() => {
    delete global.strapi;
  });

  it("moves an expected line's «Previsió pag.»", async () => {
    const r = await updateMovementDates([{ kind: 'phase-income', id: 1, date: '2026-12-15' }]);
    expect(queryUpdates).toEqual([{ uid: 'api::phase-income.phase-income', id: 1, date: '2026-12-15' }]);
    expect(r).toEqual({ updated: 1, lines: 1 });
  });

  it('moves an unpaid invoice\'s «Previsió cobrament» and «Venciment», and the lines it is assigned to', async () => {
    const r = await updateMovementDates([{ kind: 'emitted-invoices', id: 10, date: '2026-12-15' }]);
    expect(tableUpdates).toEqual([{ table: 'emitted_invoices', id: 10, estimated_payment: '2026-12-15', paybefore: '2026-12-15' }]);
    // line 3 already had that date
    expect(queryUpdates).toEqual([{ uid: 'api::phase-income.phase-income', id: 2, date: '2026-12-15' }]);
    expect(r).toEqual({ updated: 1, lines: 1 });
  });

  it("moves a received invoice's «Venciment» and its expense lines", async () => {
    await updateMovementDates([{ kind: 'received-invoices', id: 30, date: '2027-01-10' }]);
    expect(tableUpdates).toEqual([{ table: 'received_invoices', id: 30, paybefore: '2027-01-10' }]);
    expect(queryUpdates).toEqual([{ uid: 'api::phase-expense.phase-expense', id: 5, date: '2027-01-10' }]);
  });

  it.each([
    ['a paid invoice', { kind: 'emitted-invoices', id: 11 }, /ja està pagat o cobrat/],
    ['an invoice with a payment date', { kind: 'emitted-invoices', id: 12 }, /ja està pagat o cobrat/],
    ['a line with a document', { kind: 'phase-income', id: 2 }, /document assignat/],
  ])('refuses %s and changes nothing', async (_, change, message) => {
    await expect(
      updateMovementDates([{ kind: 'phase-income', id: 1, date: '2026-12-15' }, { ...change, date: '2026-12-15' }]),
    ).rejects.toThrow(message);
    expect(queryUpdates).toEqual([]);
    expect(tableUpdates).toEqual([]);
  });

  it.each([
    [[]],
    [[{ kind: 'payrolls', id: 1, date: '2026-12-15' }]],
    [[{ kind: 'phase-income', id: 1, date: '31/12/2026' }]],
    [[{ kind: 'phase-income', id: 1, date: '2026-02-31' }]],
  ])('refuses a malformed change %j', async (changes) => {
    const { MovementDateError } = require('../src/api/treasury/services/movement-dates');
    await expect(updateMovementDates(changes)).rejects.toBeInstanceOf(MovementDateError);
    expect(queryUpdates).toEqual([]);
  });

  it('the last change of a movement wins', async () => {
    await updateMovementDates([
      { kind: 'phase-income', id: 1, date: '2026-12-01' },
      { kind: 'phase-income', id: '1', date: '2026-12-20' },
    ]);
    expect(queryUpdates).toEqual([{ uid: 'api::phase-income.phase-income', id: 1, date: '2026-12-20' }]);
  });
});

describe('treasury forecast: which movements can change date (issues/370)', () => {
  const soon = (months) => moment().add(months, 'month').format('YYYY-MM-DD');

  beforeEach(() => {
    jest.resetModules();
    const rows = {
      'api::year.year': [{ id: 1, year: moment().year(), deductible_vat_pct: 100 }],
      'api::project.project': [
        {
          id: 1,
          name: 'P',
          project_state: { id: 1 },
          project_phases: [
            {
              expenses: [{ id: 7, concept: 'Esperada', total_amount: 100, vat_pct: 0, date: soon(1), paid: false }],
              incomes: [],
            },
          ],
        },
      ],
      'api::emitted-invoice.emitted-invoice': [
        { id: 10, code: 'F-10', total: 100, paid: false, emitted: soon(0), paybefore: soon(1), state: 'real' },
        { id: 11, code: 'F-11', total: 100, paid: true, paid_date: soon(0), emitted: soon(0), state: 'real' },
      ],
    };
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
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('flags expected lines and unpaid documents, not paid ones', async () => {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const ctx = {
      query: { project_states: '1', year: String(moment().year()), periodification: 'no' },
      state: { user: { id: 20 } },
      send(body) {
        this.body = body;
      },
    };
    ctx.request = { query: ctx.query };
    const actions = controller({ strapi: global.strapi });
    const result = (await actions.forecast(ctx)) || ctx.body;
    const edit = Object.fromEntries(
      result.treasury.filter((r) => ['Esperada', 'F-10', 'F-11'].includes(r.concept)).map((r) => [r.concept, [r.date_edit, r.date_edit_id]]),
    );
    expect(edit).toEqual({
      Esperada: ['phase-expense', 7],
      'F-10': ['emitted-invoices', 10],
      'F-11': [null, 11],
    });
  });
});
