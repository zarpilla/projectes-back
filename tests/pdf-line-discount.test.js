'use strict';

/**
 * issues/007 (2026-10-08): on an invoice line with a discount, the PDF's IRPF
 * column was computed from `quantity * base` without the discount, while the
 * line's VAT, its subtotal and the invoice totals all apply it. A 10% discount
 * on 300 x 0.23 with 15% IRPF printed -10,35 instead of -9,31.
 *
 * Calls the pdf action with the PDF writer mocked and checks the line cells it
 * would print.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

const invoice = {
  id: 763,
  code: '2025-039',
  emitted: '2025-04-30',
  contact: { name: 'Client' },
  lines: [
    { concept: 'Desplaçaments', quantity: 1, base: 30.45, discount: 0, vat: 21, irpf: 0 },
    { concept: 'Lloguer', quantity: 300, base: 0.23, discount: 10, vat: 21, irpf: 15 },
  ],
  total_base: 92.55,
  total_vat: 19.44,
  total_irpf: 9.32,
  total: 102.67,
};

describe('pdf action, lines with a discount', () => {
  let details;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('../utils/microinvoice', () =>
      jest.fn().mockImplementation((options) => {
        details = options.data.invoice.details;
        return { options, generate: jest.fn() };
      }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
    const ct = { uid: 'api::emitted-invoice.emitted-invoice', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      db: { query: () => ({ findOne: async () => invoice, update: async () => ({}) }) },
    };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await ctrl.pdf({ params: { id: 763, doc: 'emitted-invoice' } });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const cell = (row, label) => {
    const i = details.header.findIndex((h) => h.value === label);
    return details.parts[row][i].value;
  };

  it('applies the discount to the line IRPF, like VAT and the subtotal', () => {
    expect(cell(1, 'Descompte')).toBe('6,90 EUR (10%)');
    expect(cell(1, 'IVA')).toBe('13,04 EUR (21%)');
    expect(cell(1, 'IRPF')).toBe('-9,31 EUR (15%)');
    expect(cell(1, 'Subtotal')).toBeCloseTo(65.826, 3);
  });

  it('leaves lines without discount unchanged', () => {
    expect(cell(0, 'IVA')).toBe('6,39 EUR (21%)');
    expect(cell(0, 'Subtotal')).toBeCloseTo(36.8445, 4);
  });
});
