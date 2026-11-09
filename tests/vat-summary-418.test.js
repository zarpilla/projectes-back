'use strict';

/**
 * issues/418 (2026-11-09): IVA › «Saldo i documents» like the IRPF page: the
 * documents with VAT of a year, settled or not, per quarter (GET /treasuries/vat).
 */

const { vatSummary, yearDeductiblePct } = require('../src/api/treasury/services/vat-summary');

const doc = (id, emitted, total_vat, extra = {}) => ({
  id, code: `D${id}`, emitted, total_base: total_vat * 5, total: total_vat * 6, total_vat, contact: { id: 1, name: 'Coop' }, ...extra,
});
const YEARS = [{ year: 2026, deductible_vat_pct: 80 }, { year: 2025, deductible_vat_pct: null }];

describe('vatSummary (issues/418)', () => {
  const data = {
    emittedInvoices: [
      doc(1, '2026-01-15', 210, { vat_paid_date: '2026-04-18T00:00:00.000Z', deductible_vat_pct: 100 }),
      doc(2, '2026-02-15', 50, { state: 'draft' }), // a draft: not an invoice yet (issues/339)
      doc(3, '2026-04-02', 42),
      doc(4, '2026-05-02', 0), // no VAT
    ],
    receivedIncomes: [doc(5, '2026-03-01', 10)],
    receivedInvoices: [
      doc(6, '2026-02-01', 100, { vat_paid_date: '2026-04-18', deductible_vat_pct: 50 }), // settled at 50 %: keeps it
      doc(7, '2026-03-01', 20), // year's 80 %
      doc(8, '2025-12-01', 99), // another year
    ],
    receivedExpenses: [doc(9, '2026-05-05', 5, { document_type: { id: 1, name: 'Tiquet' } })],
  };
  const s = vatSummary(data, YEARS, 2026);

  it('lists the documents with VAT of the year, signed as Tresoreria (negative = to pay)', () => {
    expect(s.rows.map((r) => r.key)).toEqual([
      'emitted-invoices:1', 'received-invoices:6', 'received-incomes:5', 'received-invoices:7', 'emitted-invoices:3', 'received-expenses:9',
    ]);
    expect(s.rows[0]).toMatchObject({ supported: false, vat: 210, base: 1050, balance: -210, deductible_pct: null, settled: true, settled_date: '2026-04-18', quarter: 1 });
    expect(s.rows[1]).toMatchObject({ supported: true, vat: 100, deductible_pct: 50, deductible: 50, balance: 50, settled: true });
    expect(s.rows[3]).toMatchObject({ supported: true, vat: 20, deductible_pct: 80, deductible: 16, balance: 16, settled: false, settled_date: null });
    expect(s.rows[5]).toMatchObject({ document_type: 'Tiquet', to: '/document/9/received-expenses' });
  });

  it('adds them up per quarter, with their state and the model 303 date', () => {
    expect(s.quarters.map((q) => [q.quarter, q.count, q.received, q.paid, q.deductible_paid, q.balance, q.status, q.pending_balance, q.payment_date])).toEqual([
      [1, 4, 220, 120, 66, -154, 'partial', 6, '2026-04-20'],
      [2, 2, 42, 5, 4, -38, 'pending', -38, '2026-07-20'],
    ]);
  });

  it('gives the year totals', () => {
    expect(s.totals).toEqual({
      count: 6, received: 262, paid: 125, deductible_paid: 70, balance: -192,
      settled_count: 2, settled_balance: -160, pending_count: 4, pending_balance: -32,
    });
  });

  it('counts what the years before left unsettled', () => {
    const withEarlier = vatSummary(data, YEARS, 2026, {
      receivedInvoices: [doc(8, '2025-12-01', 99)],
      emittedInvoices: [doc(11, '2024-06-01', 21), doc(12, '2025-06-01', 50, { state: 'draft' })],
    });
    // 2025 is an empty year: 100 % (issues/338)
    expect(withEarlier.earlier_pending).toEqual({ count: 2, balance: 78, years: [2024, 2025] });
  });

  it('a year with no % is 100 %', () => {
    expect(yearDeductiblePct(YEARS, '2025-03-01')).toBe(100);
    expect(yearDeductiblePct(YEARS, '2030-03-01')).toBe(100);
    expect(yearDeductiblePct(YEARS, '2026-03-01')).toBe(80);
    expect(yearDeductiblePct([{ year: 2026, deductible_vat_pct: 0 }], '2026-03-01')).toBe(0);
  });
});

describe('GET /treasuries/vat (issues/418)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => delete global.strapi);

  it('reads the year and the unsettled documents of the years before', async () => {
    const calls = [];
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls.push({ uid, args });
            if (uid === 'api::year.year') return YEARS;
            if (uid === 'api::received-invoice.received-invoice' && args.where.emitted.$gte) return [doc(7, '2026-03-01', 20)];
            return [];
          },
        }),
      },
    };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const actions = require('../src/api/treasury/controllers/treasury.js')({ strapi: global.strapi });
    const ctx = { query: { year: '2026' } };
    await actions.vat(ctx);
    const invoiceCalls = calls.filter((c) => c.uid === 'api::received-invoice.received-invoice');
    expect(invoiceCalls[0].args.where.emitted).toEqual({ $gte: '2026-01-01', $lte: '2026-12-31' });
    expect(invoiceCalls[1].args.where).toMatchObject({ emitted: { $lt: '2026-01-01' }, vat_paid_date: { $null: true } });
    expect(calls.find((c) => c.uid === 'api::emitted-invoice.emitted-invoice').args.select).toContain('state');
    expect(ctx.body.totals).toMatchObject({ count: 1, paid: 20, deductible_paid: 16, balance: 16 });
  });
});
