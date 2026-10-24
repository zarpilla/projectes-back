'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/337 (2026-10-24): the VAT payments of Tresoreria («IVA executat /
 * previst pendent de saldar») went on the 30th of the month after Q1–Q3 and on
 * 20 January for Q4: the model 303 deadlines the other way round. They are the
 * 20th of April, July and October, and 30 January.
 *
 * issues/339 (2026-10-24): a draft issued invoice (state 'draft') counted as
 * charged VAT in «IVA» and in the Tresoreria VAT rows. A draft is not an invoice
 * yet: its VAT isn't due. It stays in Tresoreria as expected income.
 */

const moment = require('moment');
const { vatPaymentDate } = require('../src/api/treasury/services/vat-forecast');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year() - 1;
const emitted = (id, date, total_vat, extra = {}) => ({
  id,
  code: `E${id}`,
  emitted: date,
  total_base: 100,
  total: 100 + total_vat,
  total_vat,
  projects: [],
  ...extra,
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

describe('VAT payment deadlines (issues/337)', () => {
  it('are the 20th after Q1–Q3 and 30 January after Q4', () => {
    expect([1, 2, 3, 4].map((q) => vatPaymentDate(2026, q).format('YYYY-MM-DD'))).toEqual([
      '2026-04-20',
      '2026-07-20',
      '2026-10-20',
      '2027-01-30',
    ]);
  });

  describe('in Tresoreria', () => {
    beforeEach(() => {
      jest.resetModules();
      stubStrapi({
        'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
        'api::emitted-invoice.emitted-invoice': [1, 2, 3, 4].map((q) =>
          emitted(q, `${year}-${String(q * 3).padStart(2, '0')}-10`, 21),
        ),
      });
    });

    afterEach(() => {
      delete global.strapi;
    });

    it('put each executed quarter on its deadline', async () => {
      const { treasury } = await forecast();
      const rows = treasury.filter((t) => t.type === 'IVA executat pendent de saldar');
      expect(rows.map((t) => moment(t.date).format('YYYY-MM-DD'))).toEqual([
        `${year}-04-20`,
        `${year}-07-20`,
        `${year}-10-20`,
        `${year + 1}-01-30`,
      ]);
    });
  });
});

describe('draft issued invoices in VAT (issues/339)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::emitted-invoice.emitted-invoice': [
        emitted(1, `${year}-02-10`, 21, { state: 'real' }),
        emitted(2, `${year}-02-11`, 829.42, { state: 'draft', code: null }),
      ],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('leaves a draft out of the charged VAT and its documents', async () => {
    const { vat, vat_by_quarter } = await forecast();
    expect(vat.received).toBeCloseTo(21);
    expect(vat.documents.map((d) => d.id)).toEqual([1]);
    expect(vat_by_quarter[`${year}-Q1`].received).toBeCloseTo(21);
  });

  it('keeps the draft in Tresoreria as expected income', async () => {
    const { treasury } = await forecast();
    expect(treasury.filter((t) => t.type === 'Factura emesa').map((t) => t.total_amount)).toEqual(
      expect.arrayContaining([121, 929.42]),
    );
  });
});
