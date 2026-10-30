'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/368 (2026-10-30) — Previsió econòmica › «Resum per projectes»: the
 * forecast's incomes, invoices/expenses and non-deductible VAT per project
 * and year (`by_project=1`), the same sums as the global summary, with each
 * project's type and scope to group them.
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: { deductible_vat_pct: 50 } }),
}));

const Y = moment().year();
const line = (id, total, date, extra = {}) => ({ id, concept: `l${id}`, quantity: 1, amount: total, total_amount: total, vat_pct: 21, date, paid: false, ...extra });

const PROJECTS = [
  {
    id: 1,
    name: 'A',
    project_state: { id: 1 },
    project_type: { id: 4, name: 'Consultoria' },
    project_scope: { id: 9, name: 'Rural' },
    project_phases: [{ incomes: [line(1, 1000, `${Y}-03-01`)], expenses: [line(2, 400, `${Y}-04-01`)] }],
  },
  {
    id: 2,
    name: 'B',
    project_state: { id: 1 },
    project_phases: [
      { incomes: [line(3, 100, `${Y + 1}-03-01`)], expenses: [line(4, 300, `${Y}-05-01`), line(5, 50, `${Y + 1}-05-01`)] },
    ],
  },
];

async function forecast(query) {
  jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
  const controller = require('../src/api/treasury/controllers/treasury.js');
  const ctx = {
    query: { project_states: '1', year: String(Y), periodification: 'no', ...query },
    state: { user: { id: 20 } },
    send(body) {
      this.body = body;
    },
  };
  ctx.request = { query: ctx.query };
  const result = await controller({ strapi: global.strapi }).forecast(ctx);
  return result || ctx.body;
}

describe('treasury forecast by project (issues/368)', () => {
  let populate;

  beforeEach(() => {
    jest.resetModules();
    const rows = {
      'api::year.year': [{ id: 1, year: Y, deductible_vat_pct: 50 }],
      'api::project.project': PROJECTS,
    };
    global.strapi = {
      db: {
        ...treasuryDb(),
        query: (uid) => ({
          findMany: async (args) => {
            if (uid === 'api::project.project') populate = args.populate;
            return rows[uid] || [];
          },
          findOne: async () => null,
          count: async () => 0,
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('is left out unless asked', async () => {
    const body = await forecast({});
    expect(body.forecast_by_project).toBeUndefined();
  });

  it('gives each project its yearly sums, adding up to the global ones', async () => {
    const body = await forecast({ by_project: '1' });
    expect(populate.project_scope).toBe(true);
    const [a, b] = body.forecast_by_project;
    expect(a).toMatchObject({ id: 1, name: 'A', project_type: { id: 4, name: 'Consultoria' }, project_scope: { id: 9, name: 'Rural' } });
    expect(b).toMatchObject({ id: 2, name: 'B', project_type: null, project_scope: null });
    expect(a.years[String(Y)]).toEqual({ forecast_incomes: 1000, forecast_expenses: 400, forecast_expenses_vat: 42 });
    expect(b.years[String(Y + 1)]).toEqual({ forecast_incomes: 100, forecast_expenses: 50, forecast_expenses_vat: 5.25 });

    for (const [year, g] of Object.entries(body.forecast_by_year)) {
      for (const k of ['forecast_incomes', 'forecast_expenses', 'forecast_expenses_vat']) {
        const sum = body.forecast_by_project.reduce((acc, p) => acc + ((p.years[year] || {})[k] || 0), 0);
        expect(sum).toBeCloseTo(g[k], 6);
      }
    }
  });
});
