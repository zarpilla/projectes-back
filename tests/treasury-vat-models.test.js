'use strict';

/**
 * 2026-11-03 — Informes › Models 303 i 390 (Beta): the boxes of the AEAT VAT
 * return per quarter and for the year, from the issued and received invoices.
 * Expenses (tiquets) don't count; 0 % lines aren't classified yet.
 */

const { vatModels, contactArea } = require('../src/api/treasury/services/vat-models');

const line = (base, vat, extra = {}) => ({ quantity: 1, base, discount: 0, vat, ...extra });
const doc = (id, emitted, lines, extra = {}) => ({
  id, code: `D${id}`, emitted, lines, contact: { id: 1, name: 'Client', nif: 'B12345678', country: null }, ...extra,
});

describe('contact area', () => {
  it('reads the VAT prefix first, then the country', () => {
    expect(contactArea({ nif: 'IE6388047V', country: null })).toBe('EU');
    expect(contactArea({ nif: 'ESB12345678', country: 'IRLANDA' })).toBe('ES');
    expect(contactArea({ nif: 'B12345678', country: 'ESPAÑA' })).toBe('ES');
    expect(contactArea({ nif: '', country: 'Portugal' })).toBe('EU');
    expect(contactArea({ nif: '', country: 'ESTATS UNITS' })).toBe('NONEU');
    expect(contactArea({ nif: 'X1234567L', country: '' })).toBe('ES');
    expect(contactArea(null)).toBe('ES');
  });
});

describe('VAT models 303/390', () => {
  const data = {
    years: [{ year: 2026, deductible_vat_pct: 80 }],
    emittedInvoices: [
      doc(1, '2026-01-15', [line(1000, 21), line(200, 10), line(100, 4)]),
      doc(2, '2026-02-10', [line(500, 0)]), // 0 %: not classified
      doc(3, '2026-03-01', [line(300, 21)], { state: 'draft', total_vat: 63 }), // draft: out
      doc(4, '2026-03-20', [line(-100, 21)], { serial: { rectificative: true } }), // rectifying: 14/15
      doc(5, '2026-05-02', [line(100, 21)]),
      doc(6, '2026-08-02', [line(50, 7.5)]), // no box for 7.5 %
      doc(7, '2025-12-31', [line(999, 21)]), // another year
    ],
    receivedIncomes: [doc(20, '2026-01-20', [line(100, 21, { quantity: 2, discount: 50 })])],
    receivedInvoices: [
      doc(10, '2026-01-10', [line(400, 21), line(100, 10)]),
      doc(11, '2026-02-15', [line(80, 0)], { contact: { id: 2, name: 'Google', nif: 'IE6388047V' } }),
      doc(12, '2026-02-16', [line(60, 0)]), // domestic 0 %: not in the return
      doc(13, '2026-04-10', [line(2000, 21)]),
    ],
    receivedExpenses: [{ id: 30, emitted: '2026-02-01', total_vat: 12.6 }],
  };
  const r = vatModels(data, 2026);
  const q = (n) => r.quarters[n - 1].boxes;

  it('puts issued lines in their rate boxes, rectifying invoices in 14/15', () => {
    expect(q(1)).toMatchObject({
      '07': 1100, '09': 231, '08': 21, // invoice 1 + income 20 (2 × 100 − 50 %)
      '04': 200, '06': 20,
      '01': 100, '03': 4,
      '14': -100, '15': -21,
    });
    expect(q(1)['27']).toBe(234);
  });

  it('deducts received VAT after the year’s prorrata, on the whole base', () => {
    expect(q(1)['28']).toBe(500);
    expect(q(1)['29']).toBe(75.2); // (84 + 10) × 80 %
    expect(q(1)['45']).toBe(75.2);
    expect(q(1)['46']).toBe(158.8);
    expect(q(1)['71']).toBe(158.8);
  });

  it('carries a negative quarter to the next ones (110 / 78 / 87)', () => {
    // T2: 21 charged − 420 × 80 % = −315
    expect(q(2)['46']).toBe(-315);
    expect(q(2)['71']).toBe(-315);
    expect(q(3)).toMatchObject({ '110': 315, '78': 0, '87': 315, '71': 0 });
    expect(q(4)['110']).toBe(315);
  });

  it('lists what it could not place', () => {
    const codes = Object.fromEntries(r.issues.map((i) => [i.code, i]));
    expect(codes['issued-zero']).toMatchObject({ count: 1, base: 500 });
    expect(codes['unknown-rate']).toMatchObject({ count: 1, base: 50, vat: 3.75 });
    expect(codes['received-foreign-zero']).toMatchObject({ count: 1, base: 80, areas: [{ area: 'EU', count: 1, base: 80 }] });
    expect(r.rows.find((x) => x.id === 12 && x.kind === 'received-invoices')).toMatchObject({ not_in_return: true });
  });

  it('leaves out drafts, other years and expenses, and says so', () => {
    expect(r.rows.some((x) => x.id === 3 || x.id === 7)).toBe(false);
    const notes = Object.fromEntries(r.notes.map((n) => [n.code, n]));
    expect(notes['expenses-excluded']).toMatchObject({ count: 1, vat: 12.6 });
    expect(notes['drafts-excluded']).toMatchObject({ count: 1, vat: 63 });
    expect(notes.prorrata).toBeDefined();
    expect(notes.unsupported).toBeDefined();
  });

  it('adds the quarters up for the year', () => {
    expect(r.annual['07']).toBe(1200);
    expect(r.annual['28']).toBe(2500);
    expect(r.annual['80']).toBe(1400); // 1200 + 200 + 100 − 100
    expect(r.annual.unclassified_base).toBe(550);
    expect(r.quarters.map((x) => x.deadline)).toEqual(['2026-04-20', '2026-07-20', '2026-10-20', '2027-01-30']);
  });

  it('takes 100 % when the year has no deductible percentage (issues/338)', () => {
    const r2 = vatModels({ ...data, years: [] }, 2026);
    expect(r2.quarters[0].boxes['29']).toBe(94);
    expect(r2.notes.some((n) => n.code === 'prorrata')).toBe(false);
  });
});

describe('contact area, as countries are typed', () => {
  it.each([
    ['Espanya ', 'ES'], ['ESPAÑA', 'ES'], ['Països Catalans ', 'ES'], ['BÉLGICA', 'EU'], ['PAISOS BAIXOS', 'EU'],
    ['Slovakija', 'EU'], ['Itàlia', 'EU'], ['SUÏSSA', 'NONEU'], ['United Kingdom', 'NONEU'],
  ])('%s → %s', (country, area) => {
    expect(contactArea({ nif: '', country })).toBe(area);
  });
});

describe('the document totals win over its lines by a few cents (issues/194)', () => {
  it('moves the difference to the main rate', () => {
    const inv = doc(1, '2026-01-15', [line(10.0049, 21, { quantity: 3 }), line(5, 10)], { total_base: 35.02, total_vat: 6.82 });
    // lines: 30.01 + 5 base, 6.30 + 0.50 VAT
    const r = vatModels({ emittedInvoices: [inv] }, 2026);
    expect(r.quarters[0].boxes).toMatchObject({ '07': 30.02, '09': 6.32, '04': 5, '06': 0.5 });
  });
});
