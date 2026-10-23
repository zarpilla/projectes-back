'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/268 (2026-10-20): IVA and Tresoreria dropped every document linked
 * only to a mother project (La Diligència, project 2 «Logística»: 176 emitted
 * and 92 received invoices, 4.869,44 € + 10.235,90 € of VAT). The forecast took
 * mothers out of the project set, and that same set decided which documents
 * stay. Decision: documents booked directly on a mother are real movements and
 * count; only the plan keeps «mother = children only» (issues/169).
 */

const moment = require('moment');

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: {} }),
}));

const year = moment().year();
const doc = (id, total_vat, projects, extra = {}) => ({
  id, code: `D${id}`, emitted: `${year}-02-10`, total_base: 100, total: 100 + total_vat, total_vat, projects, ...extra,
});
const state = { id: 1 };
const mother = { id: 2, name: 'Logística', is_mother: true, project_state: state, project_phases: [] };
const child = { id: 3, name: 'Fill', is_mother: false, project_state: state, project_phases: [], mother: { id: 2 } };
const archived = { id: 4, name: 'Arxivat', is_mother: true, project_state: { id: 9 }, project_phases: [] };

function stubStrapi(rows) {
  global.strapi = {
    db: {
      ...treasuryDb(),
      query: (uid) => ({ findMany: async () => rows[uid] || [], findOne: async () => null, count: async () => 0 }),
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

async function forecast(query = {}) {
  jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
  const controller = require('../src/api/treasury/controllers/treasury.js');
  const ctx = {
    query: { _limit: '-1', year: String(year), periodification: 'no', project_states: '1,2,3', ...query },
    state: { user: { id: 20 } },
    send(body) { this.body = body; },
  };
  ctx.request = { query: ctx.query };
  const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
  return (await actions.forecast(ctx)) || ctx.body;
}

describe('documents linked only to a mother project (issues/268)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::project.project': [mother, child, archived],
      'api::emitted-invoice.emitted-invoice': [doc(1, 21, [{ id: 2 }]), doc(5, 7, [{ id: 4 }])],
      'api::received-invoice.received-invoice': [doc(2, 10, [{ id: 2 }])],
      'api::received-expense.received-expense': [doc(3, 5, [{ id: 2 }], { document_type: { name: 'Tiquet' } })],
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('count in IVA', async () => {
    const { vat } = await forecast();
    expect(vat.received).toBeCloseTo(21);
    expect(vat.paid).toBeCloseTo(15);
  });

  it('show in Tresoreria (unpaid included)', async () => {
    const { treasury } = await forecast();
    const ids = treasury.filter((t) => t.project_id === 2).length;
    expect(ids).toBeGreaterThanOrEqual(3);
  });

  it('still follow the project-state filter', async () => {
    const { treasury } = await forecast();
    expect(treasury.some((t) => t.project_id === 4)).toBe(false);
  });

  it('leave mothers out of the returned plan projects (issues/169)', async () => {
    const { projects } = await forecast();
    expect(projects.map((p) => p.id)).not.toContain(2);
  });
});
