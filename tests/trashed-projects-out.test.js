'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/236 (review 7, 2026-10-19): trashed projects still fed the forecasts
 * and several lists. On Arran de Terra «Hortes Salt» (trashed, never
 * published) added 3.240 / 1.440 € a year to Previsió econòmica and the whole
 * 2028 column, its budget lines showed as «Ingrés esperat» / «Despesa
 * esperada» in Tresoreria and in «IVA previst»; Projectes mare listed eight
 * trashed mothers and Estratègies / Intercooperació counted 15 trashed
 * projects. Decided in 128/135: a trashed project is out of lists and reports.
 */

const moment = require('moment');

const soon = (months) => moment().add(months, 'month').format('YYYY-MM-DD');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: {} }),
}));

const line = (id, extra) => ({
  id,
  concept: `l${id}`,
  quantity: 1,
  amount: 100,
  total_amount: 100,
  vat_pct: 21,
  date: soon(2),
  date_estimate_document: soon(1),
  paid: false,
  ...extra,
});

const project = (id, trashed, lineId) => ({
  id,
  name: `P${id}`,
  trashed,
  project_state: { id: 1 },
  project_phases: [{ expenses: [line(lineId)], incomes: [line(lineId + 1)] }],
});

afterEach(() => {
  delete global.strapi;
});

describe('treasury forecast without trashed projects (issues/236)', () => {
  beforeEach(() => {
    jest.resetModules();
    const rows = {
      'api::year.year': [{ id: 1, year: moment().year(), deductible_vat_pct: 100 }],
      'api::project.project': [project(1, false, 10), project(249, true, 20)],
      // already charged on the trashed project: a real movement, kept
      'api::emitted-invoice.emitted-invoice': [
        {
          id: 7,
          code: 'F-7',
          emitted: moment().format('YYYY-MM-DD'),
          paybefore: moment().format('YYYY-MM-DD'),
          paid: true,
          paid_date: moment().format('YYYY-MM-DD'),
          total: 50,
          total_base: 50,
          total_vat: 0,
          project: { id: 249 },
          projects: [],
        },
      ],
    };
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
  });

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
    const actions = controller({ strapi: global.strapi });
    return (await actions.forecast(ctx)) || ctx.body;
  }

  it('leaves its budget lines out of the expected movements, «IVA previst» and Previsió', async () => {
    const { treasury, vat_expected, forecast_by_year, projects } = await forecast();
    const expected = treasury.filter((r) => r.expenseId || r.incomeId).map((r) => r.concept);
    expect(expected.sort()).toEqual(['l10', 'l11']);
    expect(vat_expected.documents.map((d) => d.concept).sort()).toEqual(['l10', 'l11']);
    const sum = (key) => Object.values(forecast_by_year).reduce((acc, y) => acc + y[key], 0);
    expect(sum('forecast_incomes')).toBe(100);
    expect(sum('forecast_expenses')).toBe(100);
    expect(projects.map((p) => p.id)).toEqual([1]);
  });

  it('keeps the real movements already booked on it', async () => {
    const { treasury } = await forecast();
    expect(treasury.some((r) => r.concept && String(r.concept).includes('F-7'))).toBe(true);
  });
});

describe('Previsió facturació without trashed projects (issues/236)', () => {
  it('lists only the live projects', async () => {
    jest.resetModules();
    const findMany = jest.fn(async () => []);
    const income = { id: 1, concept: 'x', quantity: 1, amount: 100, total_amount: 100, date: soon(1), invoice: null, income: null };
    findMany.mockResolvedValueOnce([
      { id: 1, name: 'Viu', trashed: false, project_state: { id: 1 }, project_phases: [{ incomes: [income] }] },
      { id: 249, name: 'Hortes Salt', trashed: true, project_state: { id: 1 }, project_phases: [{ incomes: [{ ...income, id: 2 }] }] },
    ]);
    global.strapi = { db: { query: () => ({ findMany }) } };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    const controller = require('../src/api/treasury/controllers/treasury');
    const ctx = { query: {} };
    await controller.invoicingForecast(ctx);
    expect(ctx.body.rows.map((r) => r.project_id || (r.project && r.project.id) || r.projectId)).toEqual([1]);
  });
});

describe('GET /api/projects without trashed projects (issues/236)', () => {
  const findWith = async (query) => {
    jest.resetModules();
    let seen;
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => (args) =>
          Object.setPrototypeOf(build(args), {
            find: async (ctx) => {
              seen = ctx.query;
              return { data: [], meta: {} };
            },
          }),
      },
    }));
    global.strapi = { db: { query: () => ({}) }, contentType: () => ({ attributes: {} }), log: { error: jest.fn() } };
    const controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
    await controller.find({ query, state: {} });
    return seen;
  };

  it('filters them out by default (Projectes mare, Estratègies, Intercooperació)', async () => {
    const seen = await findWith({ _limit: '-1', is_mother: 'true' });
    expect(seen.filters.trashed).toBe(false);
  });

  it('leaves an explicit trash filter alone', async () => {
    expect((await findWith({ published_at_null: 'true' })).filters.trashed).toBe(true);
    expect((await findWith({ trashed: 'true' })).filters.trashed).not.toBe(false);
  });
});
