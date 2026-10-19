'use strict';

/**
 * issues/209 (2026-10-19): the IVA screen's tiles put the VAT of unsettled
 * received expenses under «IVA repercutit» (vat.received) instead of «IVA
 * suportat» (vat.paid), so they disagreed with the quarter table, which got it
 * right. The tiles must equal the sum of the quarters; `deductible_paid` is the
 * deductible part of the supported VAT, apart from the balance.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year();
const day = `${year}-02-10`;
const doc = (id, total_vat) => ({ id, code: `D${id}`, emitted: day, total_base: 100, total: 100 + total_vat, total_vat, projects: [], document_type: { name: 'Tiquet' } });

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

describe('VAT of received expenses on the IVA screen (issues/209)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 80 }],
      'api::emitted-invoice.emitted-invoice': [doc(1, 21)],
      'api::received-invoice.received-invoice': [doc(2, 10)],
      'api::received-expense.received-expense': [doc(3, 5)],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('counts received-expense VAT as supported, like the quarter table', async () => {
    const { vat, vat_by_quarter } = await forecast();
    const q = vat_by_quarter[`${year}-Q1`];

    expect(vat.received).toBeCloseTo(21);
    expect(vat.paid).toBeCloseTo(15);
    expect(q.received).toBeCloseTo(vat.received);
    expect(q.paid).toBeCloseTo(vat.paid);
    expect(q.deductible_vat).toBeCloseTo(vat.deductible_vat);
  });

  it('gives the deductible supported VAT apart from the balance', async () => {
    const { vat, vat_by_quarter } = await forecast();
    const q = vat_by_quarter[`${year}-Q1`];

    expect(vat.deductible_paid).toBeCloseTo(0.8 * 15);
    expect(q.deductible_paid).toBeCloseTo(0.8 * 15);
    expect(vat.deductible_vat).toBeCloseTo(0.8 * 15 - 21);
  });

  it('lists each pending document with its base', async () => {
    const { vat } = await forecast();

    expect(vat.documents.map((d) => [d.type, d.total_base])).toEqual([
      ['emitted-invoices', 100],
      ['received-invoices', 100],
      ['received-expenses', 100],
    ]);
  });
});
