'use strict';

/**
 * issues/419 (2026-11-09): «Salda» on the IRPF page stamps irpf_paid_date on
 * the documents ticked (POST /treasuries/irpf/settle); the run-once
 * settlePastIrpf settles what was shown as paid before.
 */

const mockLogRawUpdate = jest.fn(async () => {});
jest.mock('../src/services/change-log', () => ({
  isTracked: (uid) => uid !== 'api::payroll.payroll',
  rowWith: async (uid, where) => ({ id: where.id }),
  logRawUpdate: (...args) => mockLogRawUpdate(...args),
}));

const TABLES = {
  'api::received-invoice.received-invoice': 'received_invoices',
  'api::received-expense.received-expense': 'received_expenses',
  'api::payroll.payroll': 'payrolls',
};

// a tiny in-memory table store: knex-like where/whereIn/whereNull/update
function mockStrapi(rows) {
  const updates = [];
  const tableRows = (table) => Object.entries(TABLES).find(([, t]) => t === table)[0];
  const connection = (table) => {
    let filters = [];
    const qb = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return qb; },
      whereIn(field, ids) { filters.push((r) => ids.includes(r[field])); return qb; },
      whereNull(field) { filters.push((r) => !r[field]); return qb; },
      async update(data) {
        const hit = rows[tableRows(table)].filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, data));
        updates.push({ table, ids: hit.map((r) => r.id), data });
        return hit.length;
      },
    };
    return qb;
  };
  global.strapi = {
    db: {
      connection,
      metadata: { get: (uid) => ({ tableName: TABLES[uid] }) },
      query: (uid) => ({
        findMany: async ({ where }) => {
          let list = rows[uid] || [];
          if (where.id && where.id.$in) list = list.filter((r) => where.id.$in.includes(r.id));
          if (where.irpf_paid_date && where.irpf_paid_date.$null) list = list.filter((r) => !r.irpf_paid_date);
          if (where.paid === true) list = list.filter((r) => r.paid);
          if (where.total_irpf) list = list.filter((r) => Number(r.total_irpf));
          if (where.irpf_base) list = list.filter((r) => Number(r.irpf_base));
          return list.map((r) => ({ ...r }));
        },
      }),
    },
    log: { info: jest.fn() },
  };
  return updates;
}

afterEach(() => {
  delete global.strapi;
  mockLogRawUpdate.mockClear();
});

describe('settleIrpf (issues/419)', () => {
  const { settleIrpf, IrpfSettleError } = require('../src/api/treasury/services/irpf-settle');

  const fixtures = () => ({
    'api::received-invoice.received-invoice': [
      { id: 1, total_irpf: 150 },
      { id: 2, total_irpf: 70, irpf_paid_date: '2026-04-20' }, // already settled
      { id: 3, total_irpf: 0 }, // no IRPF
      { id: 4, total_irpf: 30 }, // not ticked: stays pending
    ],
    'api::received-expense.received-expense': [{ id: 10, total_irpf: 19 }],
    'api::payroll.payroll': [{ id: 20, irpf_base: 200.5 }],
  });

  it('settles only the ticked documents with IRPF not settled yet, and sums them', async () => {
    const rows = fixtures();
    mockStrapi(rows);
    const answer = await settleIrpf({
      receivedInvoices: [1, 2, 3, '1', 'x'],
      receivedExpenses: [10],
      payrolls: [20],
      irpf_paid_date: '2026-10-20',
    });
    expect(answer).toEqual({
      date: '2026-10-20',
      count: 3,
      total: 369.5,
      settled: { receivedInvoices: [1], receivedExpenses: [10], payrolls: [20] },
    });
    const invoices = rows['api::received-invoice.received-invoice'];
    expect(invoices.map((r) => r.irpf_paid_date || null)).toEqual(['2026-10-20', '2026-04-20', null, null]);
    // the documents' history records it; payrolls have none
    expect(mockLogRawUpdate.mock.calls.map((c) => c[0])).toEqual([
      'api::received-invoice.received-invoice',
      'api::received-expense.received-expense',
      'api::payroll.payroll',
    ]);
  });

  it('a missing list is an empty one', async () => {
    mockStrapi(fixtures());
    await expect(settleIrpf({ payrolls: [20], irpf_paid_date: '2026-10-20' })).resolves.toMatchObject({ count: 1, total: 200.5 });
  });

  it('refuses a missing or malformed date', async () => {
    mockStrapi(fixtures());
    await expect(settleIrpf({ payrolls: [20] })).rejects.toBeInstanceOf(IrpfSettleError);
    await expect(settleIrpf({ payrolls: [20], irpf_paid_date: '20/10/2026' })).rejects.toBeInstanceOf(IrpfSettleError);
  });

  it('the route and the permission exist', () => {
    const routes = require('../src/api/treasury/routes/01-custom-treasury.js').routes;
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/treasuries/irpf/settle', handler: 'treasury.irpfSettle' }),
      expect.objectContaining({ method: 'GET', path: '/treasuries/vat', handler: 'treasury.vat' }),
    ]));
    const source = require('fs').readFileSync(require.resolve('../src/services/bootstrap-permissions.js'), 'utf8');
    expect(source).toMatch(/'irpfSettle', 'vat'/);
  });
});

describe('POST /treasuries/irpf/settle (issues/419)', () => {
  beforeEach(() => jest.resetModules());

  it('answers 400 on a bad date', async () => {
    mockStrapi({});
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const actions = require('../src/api/treasury/controllers/treasury.js')({ strapi: global.strapi });
    const ctx = { request: { body: { payrolls: [1] } }, badRequest: jest.fn((m) => ({ status: 400, m })) };
    await actions.irpfSettle(ctx);
    expect(ctx.badRequest).toHaveBeenCalled();
  });
});

describe('settlePastIrpf (issues/419)', () => {
  const { settlePastIrpf } = require('../src/services/settle-past-irpf');

  it('settles what was shown as paid, on its payment date', async () => {
    const rows = {
      'api::received-invoice.received-invoice': [
        { id: 1, emitted: '2026-02-10', total_irpf: 150 }, // due 2026-04-20: past
        { id: 2, emitted: '2026-08-10', total_irpf: 70 }, // due 2026-10-20: past
        { id: 3, emitted: '2026-10-02', total_irpf: 30 }, // due 2027-01-20: ahead
        { id: 4, emitted: '2026-01-10', total_irpf: 9, irpf_paid_date: '2026-04-15' }, // kept
      ],
      'api::received-expense.received-expense': [{ id: 10, emitted: '2026-03-31', total_irpf: 19 }],
      'api::payroll.payroll': [
        { id: 20, paid: true, irpf_base: 200, irpf_date: '2026-04-18', year: { year: 2026 }, month: { month: 3 } },
        { id: 21, paid: false, irpf_base: 210, irpf_date: '2026-07-20', year: { year: 2026 }, month: { month: 4 } }, // unpaid: stays
        { id: 22, paid: true, irpf_base: 50, irpf_date: null, year: { year: 2026 }, month: { month: 5 } }, // 20 July
        { id: 23, paid: true, irpf_base: 60, irpf_date: '2027-01-20', year: { year: 2026 }, month: { month: 10 } }, // ahead
      ],
    };
    mockStrapi(rows);
    const counts = await settlePastIrpf('2026-11-09');
    expect(counts).toEqual({
      'api::received-invoice.received-invoice': 2,
      'api::received-expense.received-expense': 1,
      'api::payroll.payroll': 2,
    });
    const settled = (uid) => rows[uid].map((r) => r.irpf_paid_date || null);
    expect(settled('api::received-invoice.received-invoice')).toEqual(['2026-04-20', '2026-10-20', null, '2026-04-15']);
    expect(settled('api::received-expense.received-expense')).toEqual(['2026-04-20']);
    expect(settled('api::payroll.payroll')).toEqual(['2026-04-18', null, '2026-07-20', null]);
    // a second run changes nothing
    await expect(settlePastIrpf('2026-11-09')).resolves.toEqual({
      'api::received-invoice.received-invoice': 0,
      'api::received-expense.received-expense': 0,
      'api::payroll.payroll': 0,
    });
  });
});
