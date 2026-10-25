'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/252 (2026-10-19): on La Diligència, Tresoreria's «Des de l'inici
 * d'any» and «Des d'avui» ended 2026 22,61 € apart. Two forecast invoices of
 * 18,14 € and 4,48 € were dated today; the project forecast rows are pushed
 * before the "Avui" marker, so they counted in «Saldo avui» (the seed of «Des
 * d'avui») and again among the rows from today on. Markers are now the balance
 * at the start of their day.
 */

const moment = require('moment');
const { sortRows } = require('../src/api/treasury/services/balances');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year();
const today = moment().format('YYYY-MM-DD');
const line = (id, amount, date) => ({
  id,
  concept: `l${id}`,
  quantity: 1,
  amount,
  total_amount: amount,
  vat_pct: 0,
  date,
  date_estimate_document: date,
  paid: false,
  income_type: { name: 'Venda', vat_pct: 0 },
});
const project = {
  id: 1,
  name: 'P',
  project_state: { id: 1 },
  project_phases: [
    {
      expenses: [],
      incomes: [line(1, 18.14, today), line(2, 4.48, `${year}-01-01`), line(3, 100, `${year}-12-15`)],
    },
  ],
};

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
    query: {
      _limit: '-1',
      project_states: '1',
      year: String(year),
      periodification: 'no',
      project_likelihoods: 'null',
    },
    state: { user: { id: 20 } },
    send(body) {
      this.body = body;
    },
  };
  ctx.request = { query: ctx.query };
  const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
  return (await actions.forecast(ctx)) || ctx.body;
}

// The year-end balance as TresoreriaTable computes it in each mode: the
// marker's balance, the flows from its day on and what the noted balances after
// that day moved (the ones of the marker's day are already in it).
const yearEnd = (rows, mode) => {
  const marker = rows.find((r) => r.type === (mode === 'today' ? 'Avui' : 'Inici Any'));
  const from = mode === 'today' ? moment().format('YYYYMMDD') : `${year}0101`;
  const flows = rows
    .filter((r) => r.datef >= from && r.datef <= `${year}1231`)
    .reduce((s, r) => {
      const noted = r.is_balance_annotation || r.is_real_balance_adjustment;
      if (!noted) return s + r.total_amount;
      return r.datef > from ? s + r.balance_delta : s;
    }, 0);
  return Math.round((marker.subtotal + flows) * 100) / 100;
};

// a date of this year strictly between 1 January and today, and one after today
const between = () => {
  const d = moment().startOf('year').add(Math.floor(moment().dayOfYear() / 2), 'days');
  return d.format('YYYY-MM-DD');
};
const later = moment().add(1, 'day').year() === year ? moment().add(1, 'day').format('YYYY-MM-DD') : null;

describe('Tresoreria modes agree on the year-end balance (issues/252)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::project.project': [project],
      'api::bank-account.bank-account': [{ id: 1, name: 'Banc' }],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it("counts a forecast dated today once in «Des d'avui»", async () => {
    const { treasury } = await forecast();
    expect(treasury.some((r) => r.type === 'Avui')).toBe(true);
    expect(yearEnd(treasury, 'today')).toBe(yearEnd(treasury, 'year'));
  });

  // The open point of issues/252: «Des de l'inici d'any» left out a «Saldo
  // real» / «Saldo bancari» noted during the year (only «Saldo avui» had it).
  it('counts the balances noted during the year in both modes', async () => {
    const bank = { id: 1, name: 'Banc' };
    const treasuries = [
      { id: 1, date: `${year}-01-01`, total: 500, is_real_balance: true, bank_account: bank },
      { id: 2, date: `${year}-01-01`, total: -50, comment: 'Comissió', bank_account: bank },
    ];
    if (moment().dayOfYear() > 2) {
      treasuries.push({ id: 3, date: between(), total: 1234.56, is_real_balance: true, bank_account: bank });
    }
    if (later) treasuries.push({ id: 4, date: later, total: 0, balance: '777.77', bank_account: bank });
    stubStrapi({
      'api::project.project': [project],
      'api::bank-account.bank-account': [bank],
      'api::treasury.treasury': treasuries,
    });
    const { treasury } = await forecast();
    const noted = treasury.filter((r) => r.is_real_balance_adjustment || r.is_balance_annotation);
    expect(noted.length).toBe(treasuries.length - 1);
    noted.forEach((r) => expect(typeof r.balance_delta).toBe('number'));
    expect(yearEnd(treasury, 'today')).toBe(yearEnd(treasury, 'year'));
    if (later) {
      // from the «Saldo bancari» on, the balance is the noted one plus the
      // movements that follow it (same day included: they come after it)
      const from = later.replace(/-/g, '');
      const tail = treasury
        .filter((r) => !r.is_balance_annotation && r.datef >= from && r.datef <= `${year}1231`)
        .reduce((s, r) => s + r.total_amount, 0);
      expect(yearEnd(treasury, 'year')).toBe(Math.round((777.77 + tail) * 100) / 100);
    }
  });
});

describe('sortRows (issues/252)', () => {
  it('within a day: noted balances, then the markers, then the movements', () => {
    const rows = [
      { datef: '20261020', type: 'Ingrés esperat' },
      { datef: '20261019', type: 'Factura emesa' },
      { datef: '20261020', type: 'Saldo real ajustat', is_real_balance_adjustment: true },
      { datef: '20261020', type: 'Avui' },
      { datef: '20261020', type: 'Factura emesa' },
    ];
    expect(sortRows(rows).map((r) => `${r.datef} ${r.type}`)).toEqual([
      '20261019 Factura emesa',
      '20261020 Saldo real ajustat',
      '20261020 Avui',
      '20261020 Ingrés esperat',
      '20261020 Factura emesa',
    ]);
  });
});
