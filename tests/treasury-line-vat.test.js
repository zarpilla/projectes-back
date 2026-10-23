'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/143 (2026-10-18) — the treasury forecast took an unpaid budget line's
 * VAT from two places: the expected payment added the line's own VAT (none
 * when the line had none) and «IVA previst» only its type's (none when the
 * type had none). Both now use the project totals' rule: the line's own VAT,
 * else its type's, else 21.
 */

const moment = require('moment');

// «IVA previst» only counts lines from the current quarter on (issues/072)
const soon = (months) => moment().add(months, 'month').format('YYYY-MM-DD');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: {} }),
}));

const line = (id, vat_pct, type) => ({
  id,
  concept: `l${id}`,
  quantity: 1,
  amount: 100,
  total_amount: 100,
  vat_pct,
  date: soon(2),
  date_estimate_document: soon(1),
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
        line(1, 4, { expense_type: { name: 'Llibres', vat_pct: 21 } }),
        line(2, null, { expense_type: { name: 'Lloguer', vat_pct: 10 } }),
        line(3, null, {}),
        line(4, 0, { expense_type: { name: 'Quotes', vat_pct: 0 } }),
      ],
      incomes: [
        line(5, 10, { income_type: { name: 'Venda', vat_pct: 21 } }),
        line(6, null, {}),
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

describe('VAT of unpaid budget lines in the treasury forecast (issues/143)', () => {
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

  it("uses the line's own VAT, else its type's, else 21, in the payments and in «IVA previst»", async () => {
    const { treasury, vat_expected } = await forecast();

    const amounts = Object.fromEntries(
      treasury.filter((r) => r.expenseId || r.incomeId).map((r) => [r.concept, r.total_amount]),
    );
    expect(amounts).toEqual({ l1: -104, l2: -110, l3: -121, l4: -100, l5: 110, l6: 121 });

    const vat = Object.fromEntries(vat_expected.documents.map((d) => [d.concept, [d.vat_pct, d.total_vat]]));
    expect(vat).toEqual({ l1: [4, 4], l2: [10, 10], l3: [21, 21], l5: [10, 10], l6: [21, 21] });
    expect(vat_expected.paid).toBe(4 + 10 + 21);
    expect(vat_expected.received).toBe(10 + 21);
  });
});
