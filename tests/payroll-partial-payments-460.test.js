'use strict';

/**
 * issues/460 (2026-11-24): a bestreta (payroll) is sometimes paid to the person
 * in several goes, but it only had one «Pagada» + date, as invoices and
 * expenses had before issues/412.
 *
 * Now a payroll has `partial_payments` too. They add up to the net
 * (`net_base`, what the person gets), set `paid` / `paid_date`, can't exceed
 * the net, and Tresoreria shows one executed «Nòmina» movement per payment
 * (validated on its own) and the rest still expected on the net date.
 */

const moment = require('moment');
const { treasuryDb } = require('./helpers/treasury-db');

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));
jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, bank_account_payroll: { id: 2, name: 'Nòmines' }, options: {} }),
}));

describe('payroll lifecycle', () => {
  let stored;
  beforeEach(() => {
    jest.resetModules();
    stored = { id: 7, net_base: 1200, total: 1700, paid: false, paid_date: null, partial_payments: null };
    global.strapi = { db: { query: () => ({ findOne: async () => stored }) } };
  });
  afterEach(() => {
    delete global.strapi;
  });

  const lifecycles = () => require('../src/api/payroll/content-types/payroll/lifecycles');

  it('a payment of part of the net leaves it unpaid; reaching the net marks it paid on the last date', async () => {
    const data = { partial_payments: [{ date: '2026-03-31', amount: 500 }] };
    await lifecycles().beforeUpdate({ params: { where: { id: 7 }, data } });
    expect([data.paid, data.paid_date]).toEqual([false, null]);
    expect(data.partial_payments[0].id).toMatch(/^[0-9a-f]{12}$/);

    const all = { partial_payments: [{ id: 'a', date: '2026-03-31', amount: 500 }, { date: '2026-04-15', amount: '700' }] };
    await lifecycles().beforeUpdate({ params: { where: { id: 7 }, data: all } });
    expect([all.paid, all.paid_date]).toEqual([true, '2026-04-15']);
  });

  it('goes by the net, not by the total cost of the payroll', async () => {
    const data = { partial_payments: [{ date: '2026-03-31', amount: 1300 }] };
    await expect(lifecycles().beforeUpdate({ params: { where: { id: 7 }, data } })).rejects.toThrow(
      /no poden superar l'import net de la bestreta \(1200.00 €\)/,
    );
  });

  it('checks the net sent with the payments on create', async () => {
    const data = { net_base: '900.00', partial_payments: [{ date: '2026-03-31', amount: 900 }] };
    await lifecycles().beforeCreate({ params: { data } });
    expect([data.paid, data.paid_date, data.bank_account]).toEqual([true, '2026-03-31', { id: 2, name: 'Nòmines' }]);
  });

  it('«Paga» of Bestretes on one paid in part adds what is pending as the last payment', async () => {
    stored.partial_payments = [{ id: 'a', date: '2026-03-31', amount: 500 }];
    const data = { paid: true, paid_date: '2026-04-30' };
    await lifecycles().beforeUpdate({ params: { where: { id: 7 }, data } });
    expect(data.partial_payments.map((p) => [p.date, p.amount])).toEqual([['2026-03-31', 500], ['2026-04-30', 700]]);
    expect([data.paid, data.paid_date]).toEqual([true, '2026-04-30']);
  });

  it('with payments stored, «Pagada» follows them, whatever the write says', async () => {
    stored.partial_payments = [{ id: 'a', date: '2026-03-31', amount: 500 }];
    const data = { paid: false };
    await lifecycles().beforeUpdate({ params: { where: { id: 7 }, data } });
    expect([data.paid, data.paid_date]).toEqual([false, null]);
  });

  it('leaves a write that touches neither the payments nor the net alone', async () => {
    const data = { paid: true, paid_date: '2026-03-31' };
    await lifecycles().beforeUpdate({ params: { where: { id: 7 }, data } });
    expect(data).toEqual({ paid: true, paid_date: '2026-03-31' });
  });
});

describe('Tresoreria', () => {
  const year = moment().year() - 1;

  async function forecast(rows) {
    global.strapi = {
      db: {
        ...treasuryDb(),
        query: (uid) => ({ findMany: async () => rows[uid] || [], findOne: async () => null, count: async () => 0 }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
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

  const payroll = (over) => ({
    id: 7,
    year: { year },
    month: { month: 3 },
    users_permissions_user: { id: 3, username: 'Laia' },
    emitted: `${year}-03-31`,
    net_date: `${year}-03-31`,
    total_base: 1500,
    net_base: 1200,
    irpf_base: 300,
    irpf_date: `${year}-04-20`,
    ss_base: 0,
    other_base: 0,
    paid: false,
    paid_date: null,
    ...over,
  });

  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  const day = (t) => moment(t.date).format('YYYY-MM-DD');
  const netRows = (treasury) => treasury.filter((t) => /^Nòmina/.test(t.type));

  it('one movement per payment of the net, validated on its own, and the rest expected on the net date', async () => {
    const { treasury } = await forecast({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::treasury-validation.treasury-validation': [{ entity_type: 'payrolls', entity_id: 7, sub_type: 'payment-a' }],
      'api::payroll.payroll': [
        payroll({
          partial_payments: [
            { id: 'b', date: `${year}-04-10`, amount: 300 },
            { id: 'a', date: `${year}-03-31`, amount: 500 },
          ],
        }),
      ],
    });
    expect(netRows(treasury).map((t) => [t.type, day(t), t.total_amount, t.paid, t.validation_key, t.is_validated])).toEqual([
      ['Nòmina pagada (parcial)', `${year}-03-31`, -500, true, 'payrolls:7:payment-a', true],
      ['Nòmina esperada (pendent)', `${year}-03-31`, -400, false, null, false],
      ['Nòmina pagada (parcial)', `${year}-04-10`, -300, true, 'payrolls:7:payment-b', false],
    ]);
    // the IRPF line is not split
    expect(treasury.filter((t) => t.type === 'IRPF Nòmina').map((t) => t.total_amount)).toEqual([-300]);
  });

  it('a bestreta without partial payments is still one movement', async () => {
    const { treasury } = await forecast({
      'api::year.year': [{ id: 1, year, deductible_vat_pct: 100 }],
      'api::payroll.payroll': [payroll({ paid: true, paid_date: `${year}-03-31` })],
    });
    expect(netRows(treasury).map((t) => [t.type, t.total_amount, t.validation_key])).toEqual([['Nòmina pagada', -1200, 'payrolls:7']]);
  });
});
