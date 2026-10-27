'use strict';

/**
 * issues/348 — 2026-10-26: an «IRPF» page like «IVA», without settling, with
 * the detail of the withholdings paid to Hisenda: received invoices and
 * expenses (the 20th after their quarter) and payrolls (their IRPF date).
 */

const { irpfSummary } = require('../src/api/treasury/services/irpf-summary');

const invoice = (id, emitted, total_irpf, extra = {}) => ({
  id, code: `F${id}`, emitted, total_base: 1000, total_irpf, contact: { id: 1, name: 'Gestoria' }, ...extra,
});
const payroll = (id, month, irpf_base, extra = {}) => ({
  id,
  year: { year: 2026 },
  month: { month },
  users_permissions_user: { id: 5, username: 'anna' },
  total_base: 2000,
  irpf_base,
  irpf_date: null,
  ...extra,
});

describe('IRPF summary (issues/348)', () => {
  const data = {
    receivedInvoices: [
      invoice(1, '2026-02-10', 150),
      invoice(2, '2026-05-03', 70),
      invoice(3, '2025-12-30', 99), // another year
      invoice(4, '2026-03-01', 0), // no withholding
    ],
    receivedExpenses: [
      invoice(10, '2026-03-31', 19, { document_type: { id: 1, name: 'Lloguer' }, contact: null }),
    ],
    payrolls: [
      payroll(20, 3, 200, { irpf_date: '2026-04-20', paid: true }),
      payroll(21, 4, 210),
      payroll(22, 4, 0),
    ],
  };
  const summary = irpfSummary(data, 2026, '2026-06-01');

  it('lists every document and payroll of the year with IRPF', () => {
    expect(summary.rows.map((r) => r.key)).toEqual([
      'received-invoices:1', 'payrolls:20', 'received-expenses:10', 'payrolls:21', 'received-invoices:2',
    ]);
    const inv = summary.rows[0];
    expect(inv).toMatchObject({
      kind: 'received-invoices', code: 'F1', contact: 'Gestoria', base: 1000, irpf: 150, pct: 15,
      quarter: 1, payment_date: '2026-04-20', paid: true, to: '/document/1/received-invoices',
    });
    expect(summary.rows[2]).toMatchObject({ document_type: 'Lloguer', contact: '', pct: 1.9 });
    expect(summary.rows[1]).toMatchObject({ code: '2026-03-anna', contact: 'anna', date: '2026-03-31', quarter: 1, pct: 10, payment_date: '2026-04-20' });
    // a payroll without its own IRPF date: the 20th after its quarter
    expect(summary.rows[3]).toMatchObject({ quarter: 2, payment_date: '2026-07-20', paid: false });
  });

  it('adds them up per quarter', () => {
    expect(summary.quarters).toEqual([
      { year: 2026, quarter: 1, payrolls: 200, payrolls_count: 1, documents: 169, documents_count: 2, total: 369, payment_dates: ['2026-04-20'], paid: true },
      { year: 2026, quarter: 2, payrolls: 210, payrolls_count: 1, documents: 70, documents_count: 1, total: 280, payment_dates: ['2026-07-20'], paid: false },
    ]);
  });

  it('gives the year totals and the next payment', () => {
    expect(summary.totals).toEqual({ total: 649, paid: 369, pending: 280, overdue: 0, next: { date: '2026-07-20', amount: 280 } });
  });

  it('has no next payment once every date has passed', () => {
    expect(irpfSummary(data, 2026, '2027-01-01').totals.next).toBe(null);
  });

  // as Tresoreria: a payroll's IRPF is paid when the payroll is, its date
  // passed or not; an invoice's once its date has passed
  it("takes a payroll's own paid state, and an unpaid one past its date is overdue", () => {
    const later = irpfSummary(data, 2026, '2026-08-01');
    expect(later.rows.find((r) => r.key === 'payrolls:21')).toMatchObject({ paid: false });
    expect(later.rows.find((r) => r.key === 'received-invoices:2')).toMatchObject({ paid: true });
    expect(later.quarters[1].paid).toBe(false);
    expect(later.totals).toMatchObject({ pending: 210, overdue: 210, next: null });
  });
});

describe('GET /treasuries/irpf (issues/348)', () => {
  beforeEach(() => jest.resetModules());

  it('reads the year and answers the summary', async () => {
    const calls = {};
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls[uid] = args;
            if (uid === 'api::received-invoice.received-invoice') return [invoice(1, '2025-02-10', 150)];
            return [];
          },
        }),
      },
    };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const actions = controller({ strapi: global.strapi });
    const ctx = { query: { year: '2025' } };
    await actions.irpf(ctx);
    expect(calls['api::received-invoice.received-invoice'].where.emitted).toEqual({ $gte: '2025-01-01', $lte: '2025-12-31' });
    expect(calls['api::payroll.payroll'].where.year).toEqual({ year: 2025 });
    expect(ctx.body.year).toBe(2025);
    expect(ctx.body.totals.total).toBe(150);
  });
});
