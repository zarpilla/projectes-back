'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * 2026-11-04, webcoop: "Previsió" got a 500 from GET /treasuries/forecast
 * ("Cannot read properties of null (reading 'name')", treasury.js:958) after
 * the Quipu history import: 103 received expenses (Seguretat Social quotas)
 * have no document type, and the tenant has no document types at all. The
 * forecast labels read `document_type.name` of every received expense and
 * received income. A document without a type must still count, with a label
 * without the type.
 */

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Triodos' }, options: {} }),
}));

const expense = (id, documentType, extra = {}) => ({
  id,
  code: `2026-00${id}`,
  emitted: '2026-03-31',
  paid: true,
  paid_date: '2026-03-31',
  total: 624,
  total_base: 624,
  total_vat: 0,
  total_irpf: 0,
  document_type: documentType,
  contact: { id: 9, name: 'Seg. Social' },
  projects: [],
  ...extra,
});

const income = (id, documentType, extra = {}) => ({
  id,
  code: `2026-I${id}`,
  emitted: '2026-04-15',
  paid: false,
  total: 300,
  total_base: 300,
  total_vat: 0,
  total_irpf: 0,
  document_type: documentType,
  contact: { id: 8, name: 'Client' },
  projects: [],
  ...extra,
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
    query: { _limit: '-1', project_states: '1,2,3', year: '2026', periodification: 'no', project_likelihoods: 'null', by_project: '1' },
    state: { user: { id: 1 } },
    send (body) { this.body = body; },
  };
  ctx.request = { query: ctx.query };
  const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
  const result = await actions.forecast(ctx);
  return result || ctx.body;
}

describe('treasury forecast with documents without a document type', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
      'api::received-expense.received-expense': [
        expense(1, null),
        expense(2, { id: 3, name: 'Tiquet' }),
        expense(3, null, { paid: false, paid_date: null, partial_payments: [{ date: '2026-03-31', amount: 100 }] }),
      ],
      'api::received-income.received-income': [income(1, null), income(2, { id: 4, name: 'Subvenció' })],
    });
  });

  it('answers instead of throwing', async () => {
    await expect(forecast()).resolves.toBeTruthy();
  });

  it('keeps the untyped documents, labelled without a type', async () => {
    const { treasury } = await forecast();
    const types = treasury.map((r) => r.type);
    expect(types).toContain('Despesa pagada');
    expect(types).toContain('Despesa pagada (Tiquet)');
    expect(types).toContain('Ingrés emès');
    expect(types).toContain('Ingrés emès (Subvenció)');
    expect(types.some((t) => /null|undefined/.test(t || ''))).toBe(false);
  });
});
