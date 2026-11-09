'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/423 (2026-11-09): a «Dieta» or «Altres» in Despeses (a received
 * expense) can now have a «Venciment» in the form, as invoices do. Tresoreria
 * must put an unpaid one on that day (not on its issue date), and a paid one
 * on the day it was paid.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year();
const day = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const expense = (id, type, fields) => ({
  id,
  code: `D${id}`,
  emitted: day(3, 1),
  paybefore: null,
  paid: false,
  paid_date: null,
  total_base: 100,
  total: 100,
  total_vat: 0,
  total_irpf: 0,
  projects: [],
  document_type: { name: type },
  ...fields,
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

describe('«Venciment» of Despeses in Tresoreria (issues/423)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::received-expense.received-expense': [
        expense(1, 'Dieta', { paybefore: day(6, 30) }),
        expense(2, 'Altres', { paybefore: day(9, 15) }),
        expense(3, 'Altres', {}),
        expense(4, 'Dieta', { paybefore: day(6, 30), paid: true, paid_date: day(4, 10) }),
      ],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const rowOf = (treasury, id) => treasury.find((r) => r.to === `/document/${id}/received-expenses` && r.type.startsWith('Despesa'));

  it('an unpaid Dieta or Altres goes on its due date', async () => {
    const { treasury } = await forecast();
    expect(rowOf(treasury, 1)).toMatchObject({ paid: false, datef: day(6, 30).replace(/-/g, ''), total_amount: -100 });
    expect(rowOf(treasury, 1).type).toBe('Despesa rebuda (Dieta)');
    expect(rowOf(treasury, 2)).toMatchObject({ paid: false, datef: day(9, 15).replace(/-/g, '') });
  });

  it('without a due date, on its issue date as before', async () => {
    const { treasury } = await forecast();
    expect(rowOf(treasury, 3)).toMatchObject({ paid: false, datef: day(3, 1).replace(/-/g, '') });
  });

  it('a paid one on the day it was paid', async () => {
    const { treasury } = await forecast();
    expect(rowOf(treasury, 4)).toMatchObject({ paid: true, datef: day(4, 10).replace(/-/g, '') });
  });
});
