'use strict';

/**
 * issues/270 (2026-10-20): document lines stored the unit price (`base`) as
 * DECIMAL(10,2) while the form computed with every typed decimal: quote
 * 2026-010 with 3 × 33,3333 showed base 100,00 / total 121,00 € before saving
 * and 99,99 / 120,99 € after; 1,5 × 100,5555 was stored as 100,56. The line
 * columns keep 4 decimals now (as budget lines, issues/194), the totals round
 * each line to cents as before, and the PDF prints the 4-decimal unit price
 * (it always printed 2, the issues/243 follow-up).
 */

const path = require('path');

describe('widenDocumentLineDecimals (issues/270)', () => {
  let statements;

  function mockStrapi(client, scales) {
    statements = [];
    global.strapi = {
      log: { info: jest.fn() },
      db: {
        dialect: { client },
        connection: {
          raw: jest.fn(async (sql, bindings) => {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            if (sql.includes('information_schema')) {
              const scale = scales[bindings.join('.')];
              return [scale === undefined ? [] : [{ scale }], []];
            }
            return [{ affectedRows: 0 }, undefined];
          }),
        },
      },
    };
  }

  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('widens the unit price of every line component that keeps fewer than 4 decimals', async () => {
    mockStrapi('mysql', {
      'components_invoice_line_invoice_lines.base': 2,
      'components_invoice_line_invoice_line_expenses.base': 2,
      'components_invoice_line_ticket_lines.base': 4,
    });
    const { widenDocumentLineDecimals } = require('../src/services/widen-document-line-decimals');
    await widenDocumentLineDecimals();

    expect(statements.filter((s) => s.startsWith('ALTER'))).toEqual([
      'ALTER TABLE `components_invoice_line_invoice_lines` MODIFY `base` DECIMAL(14,4) NULL',
      'ALTER TABLE `components_invoice_line_invoice_line_expenses` MODIFY `base` DECIMAL(14,4) NULL',
    ]);
  });

  it('skips a missing table and does nothing outside MySQL', async () => {
    mockStrapi('mysql', {});
    let { widenDocumentLineDecimals } = require('../src/services/widen-document-line-decimals');
    await widenDocumentLineDecimals();
    expect(statements.filter((s) => s.startsWith('ALTER'))).toEqual([]);

    jest.resetModules();
    mockStrapi('sqlite', {});
    ({ widenDocumentLineDecimals } = require('../src/services/widen-document-line-decimals'));
    await widenDocumentLineDecimals();
    expect(statements).toEqual([]);
  });
});

describe('computeLineTotals with 4-decimal prices (issues/270)', () => {
  const { computeLineTotals } = require('../src/services/document-lifecycle');

  it('keeps 4 decimals of the price and rounds each line to cents', () => {
    expect(computeLineTotals([{ quantity: 3, base: 33.3333, vat: 21 }])).toMatchObject({
      total_base: 100,
      total_vat: 21,
      total: 121,
    });
    expect(computeLineTotals([{ quantity: 1.5, base: '100.5555', vat: 0 }]).total_base).toBe(150.83);
  });
});

describe('PDF unit price (issues/270, issues/243 follow-up)', () => {
  const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

  afterEach(() => {
    delete global.strapi;
  });

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

  it('prints up to 4 decimals and at least 2, with thousands dots', async () => {
    const data = await render({
      id: 1,
      code: '2026-010',
      emitted: '2026-10-01',
      contact: { name: 'Client' },
      lines: [
        { concept: 'A', quantity: 3, base: 33.3333, vat: 21, irpf: 0 },
        { concept: 'B', quantity: 2, base: 12.5, vat: 21, irpf: 0 },
        { concept: 'C', quantity: 2, base: '1234.5600', vat: 21, irpf: 0 },
      ],
    });
    const i = data.details.header.findIndex((h) => h.value === 'Base');
    expect(data.details.parts.map((p) => p[i].value)).toEqual(['33,3333', '12,50', '1.234,56']);
  });
});
