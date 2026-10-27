'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/050 — 2026-10-15, arrandeterra: "Previsió Econòmica" (and Tresoreria,
 * IVA, which read the same endpoint) got a 500 from GET /treasuries/forecast.
 * 87 payrolls point at 4 users deleted back in v3; populate gives
 * `users_permissions_user: null` and the payroll concept read `.username` of it.
 * Such payrolls must still count, without a name.
 */

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Cajamar' }, options: {} }),
}));

// another month each, so Tresoreria doesn't group them in one line (issues/347)
const payroll = (id, user, month = 3) => ({
  id,
  year: { year: 2026 },
  month: { month },
  users_permissions_user: user,
  net_base: 1000,
  irpf_base: 150,
  ss_base: 300,
  other_base: 20,
  net_date: '2026-03-31',
  irpf_date: '2026-04-20',
  ss_date: '2026-04-30',
  other_date: '2026-03-31',
  paid: false,
  bank_account: null,
});

function stubStrapi (rows) {
  global.strapi = {
    db: {
      ...treasuryDb(),
      query: (uid) => ({
        findMany: async () => rows[uid] || [],
        findOne: async () => null,
        count: async () => 0,
      }),
    },
    log: { info () {}, warn () {}, error () {}, debug () {} },
  };
}

async function forecast () {
  jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
  const controller = require('../src/api/treasury/controllers/treasury.js');
  const ctx = {
    query: { _limit: '-1', project_states: '1,2,3', year: '2026', periodification: 'no', project_likelihoods: 'null' },
    state: { user: { id: 20 } },
    send (body) { this.body = body; },
  };
  ctx.request = { query: ctx.query };
  const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
  const result = await actions.forecast(ctx);
  return result || ctx.body;
}

describe('treasury forecast with payrolls of deleted users', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
      'api::payroll.payroll': [payroll(1, { id: 5, username: 'anna' }), payroll(2, null, 4)],
    });
  });

  it('answers instead of throwing', async () => {
    await expect(forecast()).resolves.toBeTruthy();
  });

  it("keeps the deleted user's payroll lines, without a name", async () => {
    const { treasury } = await forecast();
    const concepts = treasury.filter((r) => /^Nòmina /.test(r.concept)).map((r) => r.concept);
    expect(concepts).toContain('Nòmina 2026-03-anna');
    expect(concepts).toContain('Nòmina 2026-04-');
    expect(concepts.filter((c) => c === 'Nòmina 2026-04-').length)
      .toBe(concepts.filter((c) => c === 'Nòmina 2026-03-anna').length);
  });
});
