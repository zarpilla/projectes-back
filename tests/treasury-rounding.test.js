'use strict';

/**
 * issues/277 (2026-10-20) — the Tresoreria export carried unrounded expected
 * payments (8535.6062, −990.1320000000001) and saldos with float noise
 * (16976.9743000003): the forecast added the line's VAT without rounding to
 * cents and the running balances summed the floats as they came.
 */

const moment = require('moment');

// «IVA previst» only counts lines from the current quarter on (issues/072)
const soon = (months) => moment().add(months, 'month').format('YYYY-MM-DD');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: {} }),
}));

const line = (id, vat_pct, type, total_amount) => ({
  id,
  concept: `l${id}`,
  quantity: 1,
  amount: total_amount,
  total_amount,
  vat_pct,
  date: soon(2),
  date_estimate_document: soon(1),
  paid: false,
  ...type,
});

// 7054,22 + 21 % = 8535,6062; 1100,1467 − 10 % VAT … amounts as Arran's export had them
const project = {
  id: 1,
  name: 'P',
  project_state: { id: 1 },
  project_phases: [
    {
      expenses: [line(1, 10, {}, 900.12)],
      incomes: [line(2, 21, {}, 7054.22), line(3, 21, {}, 0.1), line(4, 21, {}, 0.2)],
    },
  ],
};

function stubStrapi(rows) {
  global.strapi = {
    db: {
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
    query: { _limit: '-1', project_states: '1', year: String(moment().year()), periodification: 'no', project_likelihoods: 'null' },
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

describe('treasury forecast amounts to cents (issues/277)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year: moment().year(), deductible_vat_pct: 100 }],
      'api::project.project': [project],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('rounds the expected payments with VAT and every saldo to cents', async () => {
    const { treasury } = await forecast();
    const amounts = Object.fromEntries(
      treasury.filter((r) => r.expenseId || r.incomeId).map((r) => [r.concept, r.total_amount]),
    );
    expect(amounts).toEqual({ l1: -990.13, l2: 8535.61, l3: 0.12, l4: 0.24 });
    const cents = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9 && String(v).split('.')[1]?.length <= 2;
    for (const r of treasury) {
      if (r.subtotal !== undefined && r.subtotal % 1) expect(cents(r.subtotal)).toBe(true);
    }
  });
});

describe('walkBalances to cents (issues/277)', () => {
  it('does not accumulate float noise', () => {
    const { walkBalances } = require('../src/api/treasury/services/balances');
    const out = walkBalances([0.1, 0.2, 0.3, -0.1].map((total_amount) => ({ bank_account: 'A', total_amount })));
    expect(out.map((r) => r.subtotal)).toEqual([0.1, 0.3, 0.6, 0.5]);
    expect(out.map((r) => r.account_subtotal)).toEqual([0.1, 0.3, 0.6, 0.5]);
  });
});
