'use strict';

/**
 * issues/243 (2026-10-19): the invoice/quote PDF computed each line's
 * subtotal, VAT and discount unrounded, while the totals round every line to
 * cents (computeLineTotals, issues/073). Invoice 2026-035 printed a 165,91 €
 * subtotal for 1,5 × 100,55 at 10 % (base 150,82 + VAT 15,08 = 165,90), its
 * lines added 258,65 € against a 258,64 € TOTAL, and quote 2026-010 printed
 * «Descompte 28,13» where the form says 28,12. Quantities and discount
 * percentages were printed with a point («1.5», «12.5%»).
 */

const path = require('path');
const { computeLineTotals } = require('../src/services/document-lifecycle');

const CONTROLLER = path.join(
  __dirname,
  '..',
  'src',
  'api',
  'emitted-invoice',
  'controllers',
  'emitted-invoice.js',
);

async function render(invoice) {
  let options;
  jest.resetModules();
  jest.doMock('../utils/microinvoice', () =>
    jest.fn().mockImplementation((o) => {
      options = o;
      return { options: o, generate: jest.fn() };
    }),
  );
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
  const ct = { uid: 'api::emitted-invoice.emitted-invoice', attributes: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [ct.uid]: ct },
    db: { query: () => ({ findOne: async () => invoice, update: async () => ({}) }) },
  };
  const ctrl = require(CONTROLLER)({ strapi: global.strapi });
  await ctrl.pdf({ params: { id: invoice.id, doc: 'emitted-invoice' } });
  return options.data.invoice;
}

const withTotals = (invoice) => ({ ...invoice, ...computeLineTotals(invoice.lines) });

describe('PDF line amounts (issues/243)', () => {
  afterEach(() => {
    delete global.strapi;
  });

  const cells = (data, label) => {
    const i = data.details.header.findIndex((h) => h.value === label);
    return data.details.parts.map((p) => p[i].value);
  };
  const totalOf = (data, label) => data.details.total.find((t) => t.label === label).value;

  it('rounds each line like the totals, so the subtotals add up to TOTAL', async () => {
    const invoice = withTotals({
      id: 350,
      code: '2026-035',
      emitted: '2026-10-01',
      contact: { name: 'Client' },
      lines: [
        { concept: 'A', quantity: 1.5, base: 100.55, discount: 0, vat: 10, irpf: 0 },
        { concept: 'B', quantity: 1, base: 76.995, discount: 0, vat: 21, irpf: 0 },
      ],
    });
    const data = await render(invoice);

    expect(cells(data, 'Subtotal')[0]).toBe(165.9);
    expect(cells(data, 'IVA')[0]).toBe('15,08 EUR (10%)');
    const sum = cells(data, 'Subtotal').reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(totalOf(data, 'TOTAL'));
  });

  it('prints the discount the form shows, so base without discount − discount = taxable base', async () => {
    const invoice = withTotals({
      id: 49,
      code: '2026-010',
      emitted: '2026-10-01',
      contact: { name: 'Client' },
      lines: [
        { concept: 'A', quantity: 12.5, base: 17.3333, discount: 12.5, vat: 21, irpf: 0 },
        { concept: 'B', quantity: 3, base: 125.33, discount: 0, vat: 21, irpf: 0 },
      ],
    });
    const data = await render(invoice);
    const without = totalOf(data, 'Base sense descompte');
    const discount = totalOf(data, 'Descompte');

    expect(Math.round((without - discount) * 100) / 100).toBe(totalOf(data, 'Base imposable'));
    expect(cells(data, 'Descompte')[0]).toBe('27,09 EUR (12,5%)'); // 216,67 − 189,58;
  });

  it('prints quantities and percentages with a decimal comma', async () => {
    const data = await render(
      withTotals({
        id: 1,
        code: 'X',
        emitted: '2026-10-01',
        contact: { name: 'Client' },
        lines: [{ concept: 'A', quantity: 1.5, base: 10, discount: 2.5, vat: 10, irpf: 0 }],
      }),
    );

    expect(cells(data, 'Q.')).toEqual(['1,5']);
    expect(cells(data, 'Descompte')[0]).toMatch(/\(2,5%\)$/);
  });
});
