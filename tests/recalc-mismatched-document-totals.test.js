'use strict';

/**
 * Regression: issues/045 — received invoices listed at twice their amount.
 *
 * Until the issues/002 repair (2026-10-08), migrated lines showed twice in the
 * form. Saving a document then stored the doubled total. The repair removed
 * the duplicate lines but left those totals behind: on nuriasocial, 10 received
 * invoices saved on 2026-09-28 (e.g. 2025-034: one 300 € line, stored 600 €)
 * showed the doubled amount in the "Despesa" list and in exports, while the
 * form, which adds up the lines, showed the right one.
 *
 * The startup script recomputes the stored totals of every document whose
 * lines add up to something else, and leaves alone the documents that already
 * match and the ones without lines (their totals come from the base fields).
 */

const UID = 'api::received-invoice.received-invoice';

function mockStrapi(docs) {
  const updates = [];
  global.strapi = {
    contentTypes: { [UID]: {} },
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async () => (uid === UID ? docs : [])),
        update: jest.fn(),
      })),
      metadata: { get: () => ({ tableName: 'received_invoices' }) },
      connection: jest.fn(() => ({ where: (w) => ({ update: async (v) => updates.push({ ...w, ...v }) }) })),
    },
    log: { info: jest.fn() },
  };
  return { updates };
}

const run = () => require('../src/services/recalc-mismatched-document-totals').recalcMismatchedDocumentTotals();

describe('recalcMismatchedDocumentTotals (issues/045)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => { delete global.strapi; });

  it('recomputes the doubled totals from the lines', async () => {
    const { updates } = mockStrapi([
      // 2025-034: one 300 € line stored as 600 €
      { id: 310, code: '2025-034', total_base: 600, total_vat: 0, total_irpf: 0, total: 600,
        lines: [{ id: 325, base: 300, quantity: 1, discount: 0, vat: 0, irpf: 0 }] },
      // 2025-140: 18.99 + 21 % VAT stored twice
      { id: 416, code: '2025-140', total_base: 37.98, total_vat: 7.98, total_irpf: 0, total: 45.96,
        lines: [{ id: 400, base: 18.99, quantity: 1, vat: 21 }] },
    ]);
    await run();
    expect(updates).toEqual([
      { id: 310, total_base: 300, total_vat: 0, total_irpf: 0, total: 300 },
      { id: 416, total_base: 18.99, total_vat: 3.99, total_irpf: 0, total: 22.98 },
    ]);
  });

  it('leaves documents that already match their lines, and documents without lines', async () => {
    const { updates } = mockStrapi([
      { id: 1, code: 'OK', total_base: 100, total_vat: 21, total_irpf: 15, total: 106,
        lines: [{ id: 1, base: 100, quantity: 1, vat: 21, irpf: 15 }] },
      // stored rounded, within a cent of the unrounded sum
      { id: 2, code: 'ROUND', total_base: 22.98, total_vat: 4.83, total_irpf: 0, total: 27.81,
        lines: [{ id: 2, base: 7.66, quantity: 3, vat: 21 }] },
      { id: 3, code: 'NOLINES', total_base: 50, total_vat: 0, total_irpf: 0, total: 50, lines: [] },
    ]);
    await run();
    expect(updates).toEqual([]);
  });
});
