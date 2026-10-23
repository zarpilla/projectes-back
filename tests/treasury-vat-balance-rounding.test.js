'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/277 follow-up (2026-10-20): the treasury's «IVA executat pendent de
 * saldar» (and «IVA previst pendent de saldar») rows carried the raw float
 * sum of the quarter's VAT (e.g. −0.30000000000000004), so the treasury
 * export wrote unrounded amounts. They are rounded to cents now.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({
    bank_account_default: { id: 1, name: 'Cajamar' },
    options: { deductible_vat_pct: 100 },
  }),
}));

const lastYear = moment().year() - 1;

const invoice = (id, total_vat) => ({
  id,
  code: `F${id}`,
  emitted: `${lastYear}-02-10`,
  paid: true,
  paid_date: `${lastYear}-02-10`,
  total: 10 + total_vat,
  total_base: 10,
  total_vat,
  vat_paid_date: null,
});

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
    query: { _limit: '-1', project_states: '1', year: String(lastYear), periodification: 'no', project_likelihoods: 'null' },
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

describe('treasury VAT balance rows are rounded to cents (issues/277)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year: lastYear, deductible_vat_pct: 100 }],
      'api::emitted-invoice.emitted-invoice': [invoice(1, 0.1), invoice(2, 0.2)],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('writes «IVA executat pendent de saldar» in cents', async () => {
    const { treasury } = await forecast();
    const rows = treasury.filter((r) => r.type === 'IVA executat pendent de saldar');
    expect(rows).toHaveLength(1);
    expect(rows[0].total_amount).toBe(-0.3);
  });
});
