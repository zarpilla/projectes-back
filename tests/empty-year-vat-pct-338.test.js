'use strict';

/**
 * issues/338 (2026-10-24): a year with no «% IVA deduïble» (NULL in Taules
 * auxiliars › Anys; resilience 2021–2025, diligència 2023–2024, arrandeterra
 * 2020) was read three ways: 0 % in «IVA» and the Tresoreria VAT rows, 100 % in
 * the project totals and forecasts, Configuració's % in «Salda». Decided (the
 * user): an empty year is 100 % everywhere, and the empty years are filled with
 * 100 once. The project totals already read it as 100 %, so they don't change.
 */

const path = require('path');
const moment = require('moment');
const { treasuryDb } = require('./helpers/treasury-db');

const mockRawExecute = jest.fn(async () => {});
jest.mock('../src/services/raw-sql', () => ({ rawExecute: (...args) => mockRawExecute(...args) }));
jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({
    bank_account_default: { id: 1, name: 'Banc' },
    bank_account_vat: { id: 3 },
    options: { deductible_vat_pct: 70 },
  }),
}));
jest.mock('../src/services/change-log', () => ({
  isTracked: () => false,
  rowWith: async () => null,
  logRawUpdate: async () => {},
}));

const year = moment().year() - 2;
const received = {
  id: 7,
  code: 'R7',
  emitted: `${year}-02-12`,
  total_base: 100,
  total: 110,
  total_vat: 10,
  projects: [],
};
const emptyYear = { id: 1, year, deductible_vat_pct: null };

function stubStrapi(rows) {
  const create = jest.fn(async () => ({}));
  global.strapi = {
    contentType: (uid) => ({ uid, kind: 'collectionType', attributes: {}, options: {} }),
    contentTypes: {},
    db: {
      ...treasuryDb(),
      query: (uid) => ({
        findMany: async () => rows[uid] || [],
        findOne: async () => null,
        count: async () => 0,
      }),
    },
    service: () => ({ create }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { create };
}

describe('a year with no «% IVA deduïble» is 100 % (issues/338)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRawExecute.mockClear();
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('in «IVA»: its supported VAT is all deductible', async () => {
    stubStrapi({ 'api::year.year': [emptyYear], 'api::received-invoice.received-invoice': [received] });
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const ctx = {
      query: { _limit: '-1', periodification: 'no', project_likelihoods: 'null' },
      state: { user: { id: 20 } },
      send(b) {
        this.body = b;
      },
    };
    ctx.request = { query: ctx.query };
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    const { vat, vat_by_quarter } = (await actions.forecast(ctx)) || ctx.body;
    expect(vat.deductible_paid).toBeCloseTo(10);
    expect(vat.deductible_vat).toBeCloseTo(10);
    expect(vat.documents[0].theoretical_deductible_vat_pct).toBe(100);
    expect(vat_by_quarter[`${year}-Q1`].deductible_paid).toBeCloseTo(10);
  });

  it("in «Salda»: it books and stores 100 %, not Configuració's", async () => {
    const { create } = stubStrapi({
      'api::year.year': [emptyYear],
      'api::received-invoice.received-invoice': [received],
    });
    const ctrl = require(
      path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js'),
    )({ strapi: global.strapi });
    await ctrl.payVatIds({
      request: { body: { receivedInvoices: [7], vat_paid_date: `${year}-04-15` } },
      state: { user: { id: 5 } },
    });
    expect(mockRawExecute.mock.calls[0][2]).toEqual([`${year}-04-15`, 100, 7]);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ total: 10 }) });
  });

  it('in «Salda»: a year with its own % keeps it', async () => {
    const { create } = stubStrapi({
      'api::year.year': [{ ...emptyYear, deductible_vat_pct: '50.00' }],
      'api::received-invoice.received-invoice': [received],
    });
    const ctrl = require(
      path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js'),
    )({ strapi: global.strapi });
    await ctrl.payVatIds({
      request: { body: { receivedInvoices: [7], vat_paid_date: `${year}-04-15` } },
      state: { user: { id: 5 } },
    });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ total: 5 }) });
  });
});

describe('fillEmptyYearVatPct (issues/338)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  function stubYears(years) {
    const updates = [];
    const where = jest.fn(() => ({
      whereNull: () => ({
        update: async (data) => {
          let n = 0;
          for (const y of years)
            if (y.deductible_vat_pct == null) {
              Object.assign(y, data);
              n++;
            }
          updates.push(data);
          return n;
        },
      }),
    }));
    const info = jest.fn();
    global.strapi = {
      db: {
        metadata: { get: () => ({ tableName: 'years' }) },
        query: () => ({ findMany: async () => years.map((y) => ({ ...y })) }),
        connection: jest.fn(() => ({ whereIn: where })),
      },
      log: { info, warn() {}, error() {} },
    };
    return { updates, info };
  }

  it('sets the empty years to 100 and leaves the others', async () => {
    const years = [
      { id: 1, year: 2021, deductible_vat_pct: null },
      { id: 2, year: 2025, deductible_vat_pct: '77.00' },
      { id: 3, year: 2022, deductible_vat_pct: null },
      { id: 4, year: 2026, deductible_vat_pct: '0.00' },
    ];
    const { info } = stubYears(years);
    const { fillEmptyYearVatPct } = require('../src/services/fill-empty-year-vat-pct');
    await fillEmptyYearVatPct();
    expect(years.map((y) => y.deductible_vat_pct)).toEqual([100, '77.00', 100, '0.00']);
    expect(info.mock.calls[0][0]).toMatch(/2 years.*2021, 2022/);
  });

  it('does nothing when no year is empty', async () => {
    const years = [{ id: 2, year: 2025, deductible_vat_pct: '77.00' }];
    const { updates } = stubYears(years);
    const { fillEmptyYearVatPct } = require('../src/services/fill-empty-year-vat-pct');
    await fillEmptyYearVatPct();
    expect(updates).toEqual([]);
  });
});
