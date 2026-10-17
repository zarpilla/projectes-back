'use strict';

/**
 * issues/073 (2026-10-16): emitted invoice 642 stored a base of 2,452.41 while
 * its lines, as every view and Facturae show them (each rounded to cents),
 * add up to 2,452.40: the totals added up unrounded line amounts. Each line's
 * base, VAT and IRPF are now rounded before adding them, for every document
 * and for emitted invoices (which had their own copy of the arithmetic).
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));

const { computeLineTotals } = require('../src/services/document-lifecycle');

// three lines of 2.004: each shown as 2.00, unrounded they add up to 6.012
const lines = [1, 2, 3].map((id) => ({ id, base: 2.004, quantity: 1, vat: 21, irpf: 15 }));

describe('line rounding (issues/073)', () => {
  it('adds up the lines as they are shown', () => {
    expect(computeLineTotals(lines)).toEqual({
      total_base: 6,
      total_vat: 1.26, // 3 × 0.42
      total_irpf: 0.9, // 3 × 0.30
      total: 6.36,
    });
  });

  it('keeps cents exact', () => {
    const t = computeLineTotals([{ base: 0.1, quantity: 3, vat: 0 }, { base: 0.2, quantity: 1, vat: 0 }]);
    expect(t.total_base).toBe(0.5);
    expect(t.total).toBe(0.5);
  });

  it('emitted invoices use the same totals', async () => {
    jest.resetModules();
    global.strapi = { db: { query: () => ({ findOne: async () => null, findMany: async () => [] }) } };
    const lifecycles = require('../src/api/emitted-invoice/content-types/emitted-invoice/lifecycles');
    const event = { params: { data: { lines: lines.map((l) => ({ ...l })) } } };
    await lifecycles.beforeCreate(event);
    expect(event.params.data).toMatchObject({ total_base: 6, total_vat: 1.26, total_irpf: 0.9, total: 6.36 });
    delete global.strapi;
  });
});
