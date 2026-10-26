'use strict';

const { treasuryDb } = require('./helpers/treasury-db');

/**
 * issues/347 — 2026-10-26: Tresoreria showed one line per person for every
 * payroll (net, IRPF, SS, other). It must show one line per bank account for
 * the payrolls of a month, split when the dates differ, with the people in
 * the contact; a grouped line validates all its payrolls at once.
 */

jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({
    bank_account_default: { id: 1, name: 'Cajamar' },
    bank_account_payroll: { id: 2, name: 'Triodos' },
    bank_account_ss: { id: 1, name: 'Cajamar' },
    bank_account_irpf: { id: 1, name: 'Cajamar' },
    options: {},
  }),
}));

const payroll = (id, username, extra = {}) => ({
  id,
  year: { year: 2026 },
  month: { month: 3 },
  users_permissions_user: { id: id + 100, username },
  net_base: 1000.1,
  irpf_base: 150,
  ss_base: 300,
  other_base: 0,
  net_date: '2026-03-31',
  irpf_date: '2026-04-20',
  ss_date: '2026-04-30',
  paid: true,
  paid_date: '2026-03-31',
  bank_account: { id: 2, name: 'Triodos' },
  ...extra,
});

function stubStrapi (rows, validations = []) {
  global.strapi = {
    db: {
      ...treasuryDb(),
      query: (uid) => ({
        findMany: async () => (uid === 'api::treasury-validation.treasury-validation' ? validations : rows[uid] || []),
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

const netRows = (treasury) => treasury.filter((r) => r.type === 'Nòmina pagada');

describe('payroll lines grouped in Tresoreria (issues/347)', () => {
  beforeEach(() => jest.resetModules());

  it('gives one net line per bank account and date for the month', async () => {
    stubStrapi({
      'api::year.year': [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
      'api::payroll.payroll': [
        payroll(1, 'anna'),
        payroll(2, 'bernat'),
        payroll(3, 'carla'),
        // another bank account
        payroll(4, 'dani', { bank_account: { id: 1, name: 'Cajamar' } }),
        // another payment date
        payroll(5, 'eva', { net_date: '2026-04-05' }),
      ],
    });
    const { treasury } = await forecast();
    const net = netRows(treasury);
    expect(net).toHaveLength(3);

    const triodos = net.find((r) => r.bank_account === 'Triodos' && r.payroll_count === 3);
    expect(triodos).toBeTruthy();
    expect(triodos.concept).toBe('Nòmines 2026-03 (3 persones)');
    expect(triodos.contact).toBe('anna, bernat, carla');
    expect(triodos.total_amount).toBe(-3000.3);
    expect(triodos.to).toBe('/bestretes?any=2026&mes=3');
    expect(triodos.validation_keys).toEqual(['payrolls:1', 'payrolls:2', 'payrolls:3']);

    // groups of one keep the payroll's own line
    const dani = net.find((r) => r.contact === 'dani');
    expect(dani.concept).toBe('Nòmina 2026-03-dani');
    expect(dani.to).toBe('/document/4/payrolls');
    expect(dani.validation_keys).toBeUndefined();
    expect(dani.payroll_month).toBeUndefined();
    expect(net.find((r) => r.contact === 'eva')).toBeTruthy();
  });

  it('groups the IRPF and SS lines the same way', async () => {
    stubStrapi({
      'api::year.year': [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
      'api::payroll.payroll': [payroll(1, 'anna'), payroll(2, 'bernat')],
    });
    const { treasury } = await forecast();
    const irpf = treasury.filter((r) => r.type === 'IRPF Nòmina');
    const ss = treasury.filter((r) => r.type === 'SS pagat');
    expect(irpf).toHaveLength(1);
    expect(irpf[0]).toMatchObject({ concept: 'IRPF nòmines 2026-03 (2 persones)', total_amount: -300 });
    expect(ss).toHaveLength(1);
    expect(ss[0]).toMatchObject({ concept: 'SS nòmines 2026-03 (2 persones)', total_amount: -600 });
    expect(ss[0].validation_keys).toEqual(['payrolls:1:ss', 'payrolls:2:ss']);
  });

  it('keeps months apart and is validated only when all its payrolls are', async () => {
    stubStrapi(
      {
        'api::year.year': [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
        'api::payroll.payroll': [
          payroll(1, 'anna'),
          payroll(2, 'bernat'),
          payroll(3, 'anna', { month: { month: 2 } }),
          payroll(4, 'bernat', { month: { month: 2 } }),
        ],
      },
      [
        { entity_type: 'payrolls', entity_id: 1, sub_type: null },
        { entity_type: 'payrolls', entity_id: 2, sub_type: null },
        { entity_type: 'payrolls', entity_id: 3, sub_type: null },
      ],
    );
    const { treasury } = await forecast();
    const net = netRows(treasury);
    expect(net).toHaveLength(2);
    expect(net.find((r) => r.concept === 'Nòmines 2026-03 (2 persones)').is_validated).toBe(true);
    expect(net.find((r) => r.concept === 'Nòmines 2026-02 (2 persones)').is_validated).toBe(false);
  });
});

describe('treasury validation with an explicit state (issues/347)', () => {
  let rows;
  beforeEach(() => {
    jest.resetModules();
    rows = [{ id: 7, entity_type: 'payrolls', entity_id: 1, sub_type: null }];
    global.strapi = {
      db: {
        query: () => ({
          findOne: async ({ where }) => rows.find((r) => r.entity_type === where.entity_type && r.entity_id === where.entity_id) || null,
          delete: async ({ where }) => { rows = rows.filter((r) => r.id !== where.id); },
          create: async ({ data }) => { rows.push({ id: rows.length + 10, ...data }); },
        }),
      },
    };
  });

  const toggle = async (body) => {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build({ strapi: global.strapi }) } }));
    const actions = require('../src/api/treasury-validation/controllers/treasury-validation.js');
    return actions.toggle({ request: { body }, state: { user: { id: 1 } }, badRequest: (m) => m });
  };

  it('leaves an already validated payroll validated', async () => {
    expect(await toggle({ entity_type: 'payrolls', entity_id: 1, validated: true })).toMatchObject({ validated: true });
    expect(rows).toHaveLength(1);
    expect(await toggle({ entity_type: 'payrolls', entity_id: 2, validated: true })).toMatchObject({ validated: true });
    expect(rows).toHaveLength(2);
  });

  it('un-validates only when asked to', async () => {
    expect(await toggle({ entity_type: 'payrolls', entity_id: 2, validated: false })).toMatchObject({ validated: false });
    expect(rows).toHaveLength(1);
    expect(await toggle({ entity_type: 'payrolls', entity_id: 1, validated: false })).toMatchObject({ validated: false });
    expect(rows).toHaveLength(0);
  });

  it('still toggles without a state', async () => {
    expect(await toggle({ entity_type: 'payrolls', entity_id: 1 })).toMatchObject({ validated: false });
  });
});
