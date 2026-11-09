'use strict';

/**
 * issues/348 — 2026-10-26: an «IRPF» page like «IVA», without settling, with
 * the detail of the withholdings paid to Hisenda: received invoices and
 * expenses (the 20th after their quarter) and payrolls (their IRPF date).
 */

const { irpfSummary, irpfMovement, nextDeclarationDate } = require('../src/api/treasury/services/irpf-summary');

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

describe('IRPF summary (issues/348, settled since issues/419)', () => {
  const data = {
    receivedInvoices: [
      invoice(1, '2026-02-10', 150, { irpf_paid_date: '2026-04-18' }),
      invoice(2, '2026-05-03', 70),
      invoice(3, '2025-12-30', 99), // another year
      invoice(4, '2026-03-01', 0), // no withholding
    ],
    receivedExpenses: [
      invoice(10, '2026-03-31', 19, { document_type: { id: 1, name: 'Lloguer' }, contact: null, irpf_paid_date: '2026-04-18' }),
    ],
    payrolls: [
      payroll(20, 3, 200, { irpf_date: '2026-04-20', paid: true, irpf_paid_date: '2026-04-18' }),
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
      quarter: 1, deadline: '2026-04-20', payment_date: '2026-04-18', settled_date: '2026-04-18', paid: true,
      to: '/document/1/received-invoices',
    });
    expect(summary.rows[2]).toMatchObject({ document_type: 'Lloguer', contact: '', pct: 1.9 });
    expect(summary.rows[1]).toMatchObject({ code: '2026-03-anna', contact: 'anna', date: '2026-03-31', quarter: 1, pct: 10, deadline: '2026-04-20' });
    // a payroll without its own IRPF date: the 20th after its quarter
    expect(summary.rows[3]).toMatchObject({ quarter: 2, deadline: '2026-07-20', payment_date: '2026-07-20', paid: false, late: false });
  });

  it('adds them up per quarter, with what is settled', () => {
    expect(summary.quarters).toEqual([
      {
        year: 2026, quarter: 1, payrolls: 200, payrolls_count: 1, documents: 169, documents_count: 2, total: 369,
        settled: 369, settled_count: 3, pending: 0, count: 3, status: 'settled', paid: true,
        deadline: '2026-04-20', payment_dates: ['2026-04-18'],
      },
      {
        year: 2026, quarter: 2, payrolls: 210, payrolls_count: 1, documents: 70, documents_count: 1, total: 280,
        settled: 0, settled_count: 0, pending: 280, count: 2, status: 'pending', paid: false,
        deadline: '2026-07-20', payment_dates: ['2026-07-20'],
      },
    ]);
  });

  it('gives the year totals and the next payment', () => {
    expect(summary.totals).toEqual({ total: 649, paid: 369, pending: 280, pending_count: 2, late: 0, next: { date: '2026-07-20', amount: 280 } });
  });

  // issues/419: what is not settled is never paid, whatever the dates or the payroll
  it('a paid payroll or a past date is not settled', () => {
    const s = irpfSummary(
      { receivedInvoices: [invoice(5, '2026-01-10', 30)], payrolls: [payroll(23, 1, 40, { paid: true, irpf_date: '2026-04-20' })] },
      2026,
      '2026-05-01',
    );
    expect(s.rows.map((r) => r.paid)).toEqual([false, false]);
    expect(s.quarters[0]).toMatchObject({ status: 'pending', pending: 70 });
  });

  // issues/419: left out of a settlement, or entered after it → the next declaration
  it('moves what is late to the next model 111 date', () => {
    const late = irpfSummary(data, 2026, '2026-08-01');
    expect(late.rows.find((r) => r.key === 'payrolls:21')).toMatchObject({ paid: false, late: true, deadline: '2026-07-20', payment_date: '2026-10-20' });
    expect(late.rows.find((r) => r.key === 'received-invoices:2')).toMatchObject({ paid: false, late: true, payment_date: '2026-10-20' });
    expect(late.totals).toMatchObject({ pending: 280, late: 280, next: { date: '2026-10-20', amount: 280 } });
  });

  it('a quarter partly settled is «partial»', () => {
    const partly = irpfSummary(
      { ...data, receivedInvoices: [...data.receivedInvoices, invoice(6, '2026-02-20', 11)] },
      2026,
      '2026-06-01',
    );
    expect(partly.quarters[0]).toMatchObject({ status: 'partial', settled: 369, pending: 11, count: 4 });
  });

  it('counts what the years before left unsettled', () => {
    const s = irpfSummary(data, 2026, '2026-06-01', {
      receivedInvoices: [invoice(30, '2025-11-10', 12), invoice(31, '2024-03-10', 8), invoice(32, '2025-01-10', 5, { irpf_paid_date: '2025-04-20' })],
      payrolls: [{ ...payroll(33, 12, 20), year: { year: 2025 } }],
    });
    expect(s.earlier_pending).toEqual({ count: 3, amount: 40, years: [2024, 2025] });
  });
});

describe('irpfMovement / nextDeclarationDate (issues/419)', () => {
  it('the next model 111 date on or after a day', () => {
    expect(nextDeclarationDate('2026-11-09')).toBe('2027-01-20');
    expect(nextDeclarationDate('2026-10-20')).toBe('2026-10-20');
    expect(nextDeclarationDate('2026-10-21')).toBe('2027-01-20');
    expect(nextDeclarationDate('2026-01-02')).toBe('2026-01-20');
    expect(nextDeclarationDate('2026-04-21')).toBe('2026-07-20');
  });
  it('settled → its date; due ahead → the deadline; late → the next declaration', () => {
    expect(irpfMovement('2026-04-20', '2026-04-15', '2026-11-09')).toEqual({ date: '2026-04-15', paid: true, late: false });
    expect(irpfMovement('2027-01-20', null, '2026-11-09')).toEqual({ date: '2027-01-20', paid: false, late: false });
    expect(irpfMovement('2026-10-20', null, '2026-11-09')).toEqual({ date: '2027-01-20', paid: false, late: true });
    expect(irpfMovement(null, null, '2026-11-09')).toEqual({ date: null, paid: false, late: false });
    expect(irpfMovement('2026-10-20', new Date(2026, 9, 18), '2026-11-09').date).toBe('2026-10-18');
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
            calls[uid] = [...(calls[uid] || []), args];
            if (uid === 'api::received-invoice.received-invoice' && args.where.emitted.$gte) return [invoice(1, '2025-02-10', 150)];
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
    const invoiceCalls = calls['api::received-invoice.received-invoice'];
    expect(invoiceCalls[0].where.emitted).toEqual({ $gte: '2025-01-01', $lte: '2025-12-31' });
    // the years before: only what is not settled (issues/419)
    expect(invoiceCalls[1].where).toMatchObject({ emitted: { $lt: '2025-01-01' }, irpf_paid_date: { $null: true } });
    expect(calls['api::payroll.payroll'][0].where.year).toEqual({ year: 2025 });
    expect(calls['api::payroll.payroll'][1].where.year).toEqual({ year: { $lt: 2025 } });
    expect(ctx.body.year).toBe(2025);
    expect(ctx.body.totals.total).toBe(150);
  });
});
