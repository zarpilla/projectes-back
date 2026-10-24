'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/221 (2026-10-19) — «IVA previst» (IVA screen and the treasury's
 * forecast VAT payments) deducted Configuració's «% IVA deduïble» even when
 * the year had its own %, while executed VAT and the economic forecast use
 * the year's. Each forecast quarter now deducts its year's %, Configuració's
 * only as fallback.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({
    bank_account_default: { id: 1, name: 'Cajamar' },
    options: { deductible_vat_pct: 79 },
  }),
}));

const thisYear = moment().year();
const nextYear = thisYear + 1;
const today = moment().format('YYYY-MM-DD');
const nextYearDay = `${nextYear}-05-15`;

const line = (id, amount, date, type) => ({
  id,
  concept: `l${id}`,
  quantity: 1,
  amount,
  total_amount: amount,
  vat_pct: 21,
  date,
  date_estimate_document: date,
  paid: false,
  ...type,
});

const project = {
  id: 1,
  name: 'P',
  project_state: { id: 1 },
  project_phases: [
    {
      expenses: [
        line(1, 1000, today, { expense_type: { name: 'Lloguer', vat_pct: 21 } }),
        line(2, 1000, nextYearDay, { expense_type: { name: 'Lloguer', vat_pct: 21 } }),
      ],
      incomes: [
        line(3, 2000, today, { income_type: { name: 'Venda', vat_pct: 21 } }),
        line(4, 2000, nextYearDay, { income_type: { name: 'Venda', vat_pct: 21 } }),
      ],
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
      year: String(thisYear),
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
  const result = await actions.forecast(ctx);
  return result || ctx.body;
}

describe("forecast VAT uses the year's deductible % (issues/221)", () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      // this year has its own 77 %; next year has no row → Configuració's 79 %
      'api::year.year': [{ id: 1, year: thisYear, deductible_vat_pct: 77 }],
      'api::project.project': [project],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it("deducts each quarter's year %, Configuració's only as fallback", async () => {
    const { treasury, vat_expected, vat_expected_by_quarter } = await forecast();

    const quarters = Object.values(vat_expected_by_quarter).sort((a, b) => a.year - b.year);
    expect(quarters.map((q) => [q.year, q.paid, q.received, q.deductible_vat_pct])).toEqual([
      [thisYear, 210, 420, 77],
      [nextYear, 210, 420, 79],
    ]);
    expect(quarters[0].deductible_paid).toBeCloseTo(161.7, 6);
    expect(quarters[1].deductible_paid).toBeCloseTo(165.9, 6);
    expect(vat_expected.deductible_paid).toBeCloseTo(161.7 + 165.9, 6);

    const payments = treasury
      .filter((r) => r.type === 'IVA previst pendent de saldar')
      .map((r) => [r.concept.slice(12, 16), Math.round(r.total_amount * 100) / 100]);
    expect(payments).toEqual([
      [String(thisYear), -258.3], // 420 − 210 × 77 %
      [String(nextYear), -254.1], // 420 − 210 × 79 %
    ]);
  });
});
