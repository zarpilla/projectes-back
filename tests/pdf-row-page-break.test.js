/**
 * issues/318 (2026-10-22): an invoice PDF on ladili_test had a strange second
 * page. The last line of page 1 was cut: its concept, gross amount and the
 * first text line of the discount («13,63 EUR») stayed on page 1, and the rest
 * of the row («(99,9%)», IVA, subtotal) was printed alone on page 2 after a
 * large blank gap.
 *
 * The table checked for a page break with a fixed 40 pt row estimate against
 * a 50 pt bottom margin, while pdfkit breaks pages itself at its own 72 pt
 * margin. A row drawn in between was split by pdfkit in the middle of a cell.
 *
 * The same screenshot showed a row with a two-line discount («47,51 EUR
 * (99,9%)») overlapped by the next row: the next row started below the last
 * cell drawn, not below the tallest one.
 *
 * Guards: every row of the table, wrapped cells included, is drawn whole on
 * one page, for every number of rows that brings a row near the page bottom,
 * and starts below every cell of the row before it.
 */
const PDFDocument = require('pdfkit');
const MicroInvoice = require('../utils/microinvoice');

const header = [
  { value: 'Concepte', width: 0.3 },
  { value: 'Import brut', width: 0.2 },
  { value: 'Descompte', width: 0.15 },
  { value: 'IVA', width: 0.15 },
  { value: 'Subtotal', width: 0.2 },
];

function row(i, wrap) {
  return [
    { value: `Comanda 15/10/2026 | ${25000 + i}-R | DJ - BAIX EMPORDÀ`, width: 0.3 },
    { value: 13.64, price: true, width: 0.2 },
    { value: wrap ? '13,63 EUR (99,9%)' : '- EUR (0%)', width: 0.15 },
    { value: '- EUR (21%)', width: 0.15 },
    { value: 0.01, price: true, width: 0.2 },
  ];
}

function render(rows) {
  const calls = [];
  const original = PDFDocument.prototype.text;
  const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (text, ...args) {
    const before = this.page;
    const result = original.call(this, text, ...args);
    const y = typeof args[1] === 'number' ? args[1] : this.y;
    calls.push({ text: String(text), before, after: this.page, y, bottom: this.y });
    return result;
  });
  try {
    const invoice = new MicroInvoice({
      data: {
        invoice: {
          name: 'Factura',
          header: [{ label: 'Número', value: 'F-1' }],
          customer: [{ label: 'CLIENT/A', value: ['Client'] }],
          seller: [{ label: 'PROVEÏDOR/A', value: ['Seller'] }],
          legal: [{ value: 'Peu de factura' }],
          details: { header, parts: rows, total: [{ label: 'TOTAL', value: 1, price: true }] },
        },
      },
    });
    invoice.generate();
  } finally {
    spy.mockRestore();
  }
  return calls;
}

describe('invoice PDF table rows and page breaks (issues/318)', () => {
  it.each([false, true])('never splits a row across pages (wrapped discount: %s)', (wrap) => {
    for (let n = 20; n <= 60; n++) {
      const rows = Array.from({ length: n }, (_, i) => row(i, wrap || i === n - 1));
      const calls = render(rows);
      // no single text call ran over the page end
      const split = calls.filter((c) => c.before !== c.after);
      expect({ n, split: split.map((c) => c.text) }).toEqual({ n, split: [] });
      // every cell of a row on the same page
      for (let i = 0; i < n; i++) {
        const concept = calls.find((c) => c.text.includes(`${25000 + i}-R`));
        const idx = calls.indexOf(concept);
        const cells = calls.slice(idx, idx + header.length);
        expect({ n, i, pages: new Set(cells.map((c) => c.after)).size }).toEqual({ n, i, pages: 1 });
      }
    }
  });

  it('starts each row below the tallest cell of the previous one', () => {
    const rows = [row(0, false), row(1, true), row(2, false)];
    rows[1][0].value = 'Comanda 13/10/2026 | 25001-R | DT - (TARDA) EMPORDÀ amb un concepte llarg que fa salt de línia';
    const calls = render(rows);
    const rowCells = (i) => {
      const idx = calls.findIndex((c) => c.text.includes(`${25000 + i}-R`));
      return calls.slice(idx, idx + header.length);
    };
    for (const i of [0, 1]) {
      const prevBottom = Math.max(...rowCells(i).map((c) => c.bottom));
      expect(rowCells(i + 1)[0].y).toBeGreaterThanOrEqual(prevBottom);
    }
  });
});
