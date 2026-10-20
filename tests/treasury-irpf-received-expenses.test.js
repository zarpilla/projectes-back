'use strict';

/**
 * issues/242 (2026-10-19): the «IRPF Factura» row of a received expense
 * (date = end of quarter + 20 days) was always `paid: false`, so it stayed in
 * Tresoreria's «Previstos endarrerits» forever (73 of 108 overdue rows on Arran
 * de Terra). Received invoices already count it as executed once its date has
 * passed; received expenses must do the same.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year();
const past = moment().subtract(1, 'year').format('YYYY-MM-DD');
const future = moment().add(1, 'year').format('YYYY-MM-DD');
const doc = (id, emitted) => ({
  id,
  code: `D${id}`,
  emitted,
  paid: true,
  paid_date: emitted,
  total_base: 100,
  total: 70,
  total_vat: 0,
  total_irpf: 30,
  projects: [],
  document_type: { name: 'Tiquet' },
});

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

describe('IRPF rows of received expenses (issues/242)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::received-expense.received-expense': [doc(1, past), doc(2, future)],
      'api::received-invoice.received-invoice': [{ ...doc(3, past), document_type: undefined }],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('counts the IRPF as executed once its date has passed, as for received invoices', async () => {
    const { treasury } = await forecast();
    const irpf = (to) => treasury.find((r) => r.type === 'IRPF Factura' && r.to === to);

    expect(irpf('/document/3/received-invoices').paid).toBe(true);
    expect(irpf('/document/1/received-expenses').paid).toBe(true);
    expect(irpf('/document/2/received-expenses').paid).toBe(false);
  });
});
