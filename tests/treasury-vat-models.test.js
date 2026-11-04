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

describe('phase 2: classified 0 % lines, reverse charge and capital goods', () => {
  const ie = { id: 7, name: 'Google', nif: 'IE6388047V', country: null };
  const us = { id: 8, name: 'Zoom', nif: '', country: 'ESTATS UNITS' };
  const data = {
    years: [{ year: 2026, deductible_vat_pct: 80 }],
    emittedInvoices: [
      doc(1, '2026-01-10', [line(1000, 21)]),
      doc(2, '2026-01-11', [line(500, 0)], { vat_operation: 'E1' }), // exempt: 390 box 83
      doc(3, '2026-01-12', [line(300, 0)], { vat_operation: 'N2', contact: ie }), // 120
      doc(4, '2026-01-13', [line(200, 0)], { vat_operation: 'E5' }), // 59
      doc(5, '2026-01-14', [line(100, 0)], { vat_operation: 'E2' }), // 60
      doc(6, '2026-01-15', [line(50, 0)], { vat_operation: 'S2' }), // 122
      doc(9, '2026-01-16', [line(40, 0)], { vat_operation: 'N1' }), // outside the return
      doc(10, '2026-02-01', [line(70, 0)], { contact: ie }), // unclassified: proposal from the same contact
      doc(11, '2026-02-02', [line(60, 0)], { contact: { id: 9, name: 'Local', nif: 'B1', country: null } }), // no proposal
    ],
    receivedInvoices: [
      doc(20, '2026-01-05', [line(100, 0)], { contact: ie, reverse_charge: 'intracom', reverse_charge_rate: 21 }),
      doc(21, '2026-01-06', [line(200, 0)], { contact: us, reverse_charge: 'isp' }), // rate 21 by default
      doc(22, '2026-01-07', [line(1000, 21, { expense_type: { id: 1, capital_goods: true } }), line(100, 21)]),
      doc(23, '2026-01-08', [line(30, 0)], { contact: ie, reverse_charge: 'none' }),
      doc(24, '2026-02-08', [line(40, 0)], { contact: us }), // unclassified: same contact's isp
      doc(25, '2026-02-09', [line(45, 0)], { contact: { id: 10, name: 'Mailchimp', nif: '', country: 'Irlanda' } }),
    ],
  };
  const r = vatModels(data, 2026);
  const t1 = r.quarters[0].boxes;
  const row = (kind, id) => r.rows.find((x) => x.kind === kind && x.id === id);

  it('puts the classified issued 0 % lines in the information boxes', () => {
    expect(t1).toMatchObject({ '120': 300, '59': 200, '60': 100, '122': 50 });
    expect(row('emitted-invoices', 2)).toMatchObject({ not_in_return: true, annual_box: '83' });
    expect(row('emitted-invoices', 9)).toMatchObject({ not_in_return: true, annual_box: null });
  });

  it('self-assesses reverse charges: charged and deducted after the prorrata', () => {
    expect(t1).toMatchObject({ '10': 100, '11': 21, '36': 100, '37': 16.8 }); // intra-EU
    expect(t1).toMatchObject({ '12': 200, '13': 42 }); // other reverse charge
    // 28/29: the isp purchase and the 100 € line; 30/31: the capital goods line
    expect(t1).toMatchObject({ '28': 300, '29': round(42 * 0.8 + 21 * 0.8), '30': 1000, '31': 168 });
    expect(t1['27']).toBe(210 + 21 + 42);
    expect(row('received-invoices', 23)).toMatchObject({ not_in_return: true });
  });

  it('proposes the same contact’s classification, or one from its country', () => {
    expect(row('emitted-invoices', 10)).toMatchObject({ issue: 'issued-zero', proposal: 'N2' });
    expect(row('emitted-invoices', 11)).toMatchObject({ issue: 'issued-zero', proposal: null });
    expect(row('received-invoices', 24)).toMatchObject({ issue: 'received-foreign-zero', proposal: 'isp' });
    expect(row('received-invoices', 25)).toMatchObject({ issue: 'received-foreign-zero', proposal: 'intracom' });
    const r2 = vatModels({ ...data, history: { issued: [{ id: 99, emitted: '2025-05-01', vat_operation: 'E1', contact: { id: 9 } }] } }, 2026);
    expect(r2.rows.find((x) => x.kind === 'emitted-invoices' && x.id === 11).proposal).toBe('E1');
  });

  it('gives the 390 volume of operations and an estimate of the final prorrata', () => {
    expect(r.annual).toMatchObject({ '80': 1000, '83': 500, '84': 300, '93': 200, '94': 100, '125': 50, '88': 2150 });
    // with a right to deduct: 1650 of 2150 → 77 % (rounded up)
    expect(r.prorrata.provisional).toBe(80);
    expect(r.prorrata.definitive).toBe(77);
    // VAT paid: 21 + 42 + 210 + 21 = 294 → × (77 − 80) %
    expect(r.prorrata.regularisation).toBe(-8.82);
  });
});

function round(v) {
  return Math.round(v * 100) / 100;
}

describe('classify writes', () => {
  const { classifyWrites } = require('../src/api/treasury/services/vat-classify');

  it('checks kinds and values, and sets the reverse charge rate', () => {
    expect(classifyWrites([
      { kind: 'emitted-invoices', id: 1, value: 'E1' },
      { kind: 'received-incomes', id: 2, value: null },
      { kind: 'received-invoices', id: 3, value: 'intracom' },
      { kind: 'received-invoices', id: 4, value: 'isp', rate: 10 },
      { kind: 'received-invoices', id: 5, value: 'none' },
    ])).toEqual({
      'emitted-invoices': [{ id: 1, data: { vat_operation: 'E1' } }],
      'received-incomes': [{ id: 2, data: { vat_operation: null } }],
      'received-invoices': [
        { id: 3, data: { reverse_charge: 'intracom', reverse_charge_rate: 21 } },
        { id: 4, data: { reverse_charge: 'isp', reverse_charge_rate: 10 } },
        { id: 5, data: { reverse_charge: 'none' } },
      ],
    });
    expect(() => classifyWrites([])).toThrow();
    expect(() => classifyWrites([{ kind: 'received-expenses', id: 1, value: 'E1' }])).toThrow();
    expect(() => classifyWrites([{ kind: 'emitted-invoices', id: 1, value: 'intracom' }])).toThrow();
    expect(() => classifyWrites([{ kind: 'received-invoices', id: 1, value: 'isp', rate: 150 }])).toThrow();
    expect(() => classifyWrites([{ kind: 'emitted-invoices', id: 'x', value: 'E1' }])).toThrow();
  });
});

describe('phase 3: filed returns, final prorrata and the 390', () => {
  const data = () => ({
    years: [{ year: 2026, deductible_vat_pct: 80, final_deductible_vat_pct: 75 }],
    emittedInvoices: [
      doc(1, '2026-01-10', [line(1000, 21)]),
      doc(2, '2026-04-10', [line(100, 21)]),
      doc(3, '2026-05-10', [line(400, 0)], { vat_operation: 'E1' }),
    ],
    receivedInvoices: [
      doc(10, '2026-02-10', [line(2000, 21)]), // T1: 210 − 336 = −126
      doc(11, '2026-04-11', [line(100, 0)], { contact: { id: 7, name: 'G', nif: 'IE1' }, reverse_charge: 'intracom', reverse_charge_rate: 21 }),
      doc(12, '2026-10-11', [line(50, 0)], { contact: { id: 8, name: 'Books', nif: 'DE1' }, reverse_charge: 'intracom_goods', reverse_charge_rate: 4 }),
    ],
    returns: [],
  });

  it('puts the final prorrata regularisation in box 44 of the last quarter', () => {
    const r = vatModels(data(), 2026);
    // VAT paid in the year: 420 + 21 + 2 = 443 → × (75 − 80) %
    expect(r.quarters[3].boxes['44']).toBe(-22.15);
    expect(r.quarters[0].boxes['44']).toBe(0);
    expect(r.final_deductible_pct).toBe(75);
    expect(r.model390.boxes['522']).toBe(-22.15);
  });

  it('carries what a filed return says, and the year before’s 4T asking to compensate', () => {
    const d = data();
    d.returns = [
      { id: 1, model: '303', year: 2025, period: '4T', declaration_type: 'C', boxes: { '71': -50, '87': 10 } },
      { id: 2, model: '303', year: 2026, period: '1T', declaration_type: 'C', boxes: { '71': -200, '87': 0 }, documents: {} },
    ];
    const r = vatModels(d, 2026);
    expect(r.quarters[0].boxes['110']).toBe(60);
    // T2 starts from the filed T1 (200), not from the documents (126 + 60 …)
    expect(r.quarters[1].boxes['110']).toBe(200);
    expect(r.quarters[0].filed).toMatchObject({ id: 2, declaration_type: 'C' });
    expect(r.quarters[1].filed).toBe(null);
    expect(r.model390.boxes['85']).toBe(60);
  });

  it('says what changed since a quarter was filed', () => {
    const d = data();
    const first = vatModels(d, 2026);
    const { documentSnapshot } = require('../src/api/treasury/services/vat-models');
    d.returns = [{
      id: 3, model: '303', year: 2026, period: '1T', declaration_type: 'C',
      boxes: first.quarters[0].boxes, documents: documentSnapshot(first.rows.filter((x) => x.quarter === 1)),
    }];
    expect(vatModels(d, 2026).quarters[0].changes).toBe(null);
    // an invoice entered afterwards in the filed quarter
    d.emittedInvoices.push(doc(4, '2026-03-30', [line(100, 21)]));
    const changes = vatModels(d, 2026).quarters[0].changes;
    expect(changes.boxes.find((b) => b.box === '09')).toEqual({ box: '09', filed: 210, now: 231 });
    expect(changes.documents).toEqual([expect.objectContaining({ id: 4, change: 'added', vat: 21 })]);
  });

  it('gives the 390 its own boxes', () => {
    const b = vatModels(data(), 2026).model390.boxes;
    expect(b).toMatchObject({ '05': 1100, '06': 231 });
    // intra-EU services at 21 % and goods at 4 %
    expect(b).toMatchObject({ '551': 100, '552': 21, '21': 50, '22': 2 });
    expect(b['33']).toBe(1250);
    expect(b['34']).toBe(254);
    // deductible: interior 21 %, intra-EU services 21 %, intra-EU goods 4 %, after the 80 % prorrata
    expect(b).toMatchObject({ '605': 2000, '606': 336, '48': 2000, '49': 336, '637': 100, '638': 16.8, '597': 100, '598': 16.8, '214': 50, '215': 1.6, '56': 50, '57': 1.6 });
    expect(b['64']).toBe(round(336 + 16.8 + 1.6 - 22.15));
    expect(b['65']).toBe(round(254 - b['64']));
    expect(b).toMatchObject({ '99': 1100, '105': 400, '108': 1500 });
    // the prorrata applies: totals, operations with a right to deduct, the final %
    expect(b).toMatchObject({ '115': 1500, '116': 1100, '117': 'G', '118': 75 });
  });
});

describe('AEAT files', () => {
  const { file303, file390, number, text } = require('../src/api/treasury/services/aeat-file');
  const spec303 = require('../src/api/treasury/services/aeat/dr303-2026.json');
  const field = (spec, sheet, box) => spec.pages.find((p) => p.sheet === sheet).fields.find((f) => f.box === box);
  const me = { nif: 'F-12345678', name: "Cooperativa L'Era, SCCL" };

  it('formats numbers and text as the design wants them', () => {
    expect(number(1234.5, 17, true)).toBe('00000000000123450');
    expect(number(-12.34, 17, true)).toBe('N0000000000001234');
    expect(() => number(-1, 17, false)).toThrow();
    expect(number(100, 5, false)).toBe('10000');
    expect(text("Cooperativa L'Era, SCCL — Ñ ç", 30)).toBe('COOPERATIVA L ERA SCCL Ñ Ç    ');
  });

  it('writes a quarter with its boxes in their positions', () => {
    const r = vatModels({
      years: [],
      emittedInvoices: [doc(1, '2026-01-10', [line(1000, 21)])],
      receivedInvoices: [doc(2, '2026-01-11', [line(2000, 21)])],
    }, 2026);
    const out = file303({ year: 2026, period: '1T', boxes: r.quarters[0].boxes, declarationType: 'C', me });
    expect(out.startsWith('<T303020261T0000><AUX>')).toBe(true);
    expect(out.endsWith('</T303020261T0000>')).toBe(true);
    const page1 = out.slice(328, 328 + 1581);
    expect(page1.slice(0, 13)).toBe('<T30301000> C');
    expect(page1.slice(13, 22)).toBe('F12345678');
    const at = (sheet, box, page) => { const f = field(spec303, sheet, box); return page.slice(f.pos - 1, f.pos - 1 + f.len); };
    expect(at('DP30301', '07', page1)).toBe('00000000000100000');
    expect(at('DP30301', '08', page1)).toBe('02100');
    expect(at('DP30301', '29', page1)).toBe('00000000000042000');
    expect(at('DP30301', '46', page1)).toBe('N0000000000021000');
    const page3 = out.slice(328 + 1581, 328 + 1581 + 1017);
    expect(page3.startsWith('<T30303000>')).toBe(true);
    expect(at('DP30303', '71', page3)).toBe('N0000000000021000');
    expect(at('DP30303', '65', page3)).toBe('10000');
    // no bank page unless direct debit or refund
    expect(out).not.toContain('<T303DID00>');
    expect(() => file303({ year: 2026, period: '1T', boxes: r.quarters[0].boxes, declarationType: 'U', me })).toThrow(/IBAN/);
    const debit = file303({ year: 2026, period: '1T', boxes: r.quarters[0].boxes, declarationType: 'U', me, iban: 'ES91 2100 0418 4502 0005 1332' });
    expect(debit).toContain('<T303DID00>           ES9121000418450200051332');
  });

  it('adds the prorrata page to the last quarter', () => {
    const boxes = vatModels({ years: [], emittedInvoices: [doc(1, '2026-11-10', [line(100, 21)])] }, 2026).quarters[3].boxes;
    const out = file303({ year: 2026, period: '4T', boxes, declarationType: 'I', me: { ...me, aeat_cnae: '7490' }, prorrata: { total: 1000, with_right: 800, pct: 80 } });
    expect(out).toContain('<T30305000> 7490' + '00000000000100000' + '00000000000080000' + 'G' + '08000');
  });

  it('writes the year’s 390 with all its pages', () => {
    const r = vatModels({ years: [], emittedInvoices: [doc(1, '2026-01-10', [line(1000, 21)])] }, 2026);
    const out = file390({ year: 2026, boxes: r.model390.boxes, me: { ...me, aeat_activity: 'Serveis', aeat_activity_code: 'A03', aeat_iae: '8499' } });
    expect(out.startsWith('<T390020260A0000><AUX>')).toBe(true);
    for (const page of ['01000', '02000', '02B00', '03000', '04000', '05000', '06000', '07000', '08000']) expect(out).toContain(`<T390${page}>`);
    expect(out.endsWith('</T390020260A0000>')).toBe(true);
    const page1 = out.slice(out.indexOf('<T39001000>'));
    expect(page1.slice(13, 22)).toBe('F12345678');
    expect(page1.slice(148, 191)).toBe('SERVEIS'.padEnd(40, ' ') + 'A03');
  });
});

describe('agrarian compensation, foreign VAT and received rectifying invoices', () => {
  const farmer = { id: 20, name: "L'hort del Puig SCP", nif: 'J12345678', country: null };
  const pt = { id: 21, name: 'Porto Hostel', nif: 'PT123456789', country: 'Portugal' };
  const amazon = { id: 22, name: 'Amazon EU', nif: 'LU26375245', country: 'Luxembourg' };
  const data = {
    years: [{ year: 2026, deductible_vat_pct: 100 }],
    receivedInvoices: [
      doc(1, '2026-01-10', [line(100, 12)], { contact: farmer }), // REAGP, unclassified
      doc(2, '2026-01-11', [line(200, 12)], { contact: farmer, vat_special: 'reagp' }),
      doc(3, '2026-01-12', [line(50, 6)], { contact: pt }), // foreign VAT, unclassified
      doc(4, '2026-01-13', [line(60, 6)], { contact: pt, vat_special: 'foreign_vat' }),
      doc(5, '2026-01-14', [line(30, 21)], { contact: amazon }), // Spanish VAT from abroad: proposed as wrongly charged
      doc(6, '2026-01-15', [line(40, 21)], { contact: amazon, vat_special: 'none' }),
      doc(7, '2026-01-16', [line(-100, 21)], { total_base: -100, total_vat: -21 }), // a credit note received
    ],
  };
  const r = vatModels(data, 2026);
  const row = (id) => r.rows.find((x) => x.kind === 'received-invoices' && x.id === id);
  const t1 = r.quarters[0].boxes;

  it('proposes and deducts the agrarian compensation in box 42', () => {
    expect(row(1)).toMatchObject({ issue: 'received-reagp', proposal: 'reagp', classify: { field: 'vat_special', value: null } });
    expect(row(2)).toMatchObject({ vat_box: '42', reagp: true });
    expect(t1['42']).toBe(24);
    expect(r.model390.boxes).toMatchObject({ '60': 200, '61': 24 });
  });

  it('keeps foreign VAT out of the return, and Spanish VAT charged from abroad in it when classified so', () => {
    expect(row(3)).toMatchObject({ issue: 'received-foreign-vat', proposal: 'foreign_vat' });
    expect(row(4)).toMatchObject({ not_in_return: true });
    expect(row(5)).toMatchObject({ issue: 'received-foreign-vat', proposal: 'wrong_vat' });
    expect(row(6)).toMatchObject({ base_box: '28', vat_box: '29' });
  });

  it('puts a received rectifying invoice in 40/41', () => {
    expect(row(7)).toMatchObject({ base_box: '40', vat_box: '41' });
    expect(t1).toMatchObject({ '28': 40, '29': 8.4, '40': -100, '41': -21 });
    expect(t1['45']).toBe(round(8.4 - 21 + 24));
    expect(r.model390.boxes).toMatchObject({ '639': -100, '62': -21 });
    expect(r.issues.map((i) => i.code)).toEqual(['received-reagp', 'received-foreign-vat']);
  });

  it('classifies the lines with VAT through vat_special', () => {
    const { classifyWrites } = require('../src/api/treasury/services/vat-classify');
    expect(classifyWrites([{ kind: 'received-invoices', id: 1, field: 'vat_special', value: 'reagp' }])).toEqual({
      'received-invoices': [{ id: 1, data: { vat_special: 'reagp' } }],
    });
    expect(() => classifyWrites([{ kind: 'received-invoices', id: 1, field: 'vat_special', value: 'isp' }])).toThrow();
    expect(() => classifyWrites([{ kind: 'emitted-invoices', id: 1, field: 'vat_special', value: 'reagp' }])).toThrow();
  });
});

// 2026-11-04, validation of branch model-303: the 390's box 230 («adquisiciones
// interiores exentas») summed every received row out of the return, foreign
// VAT and purchases from abroad included. Only domestic 0 % purchases count.
describe('the 390’s exempt domestic purchases (230)', () => {
  const pt = { id: 21, name: 'Porto Hostel', nif: 'PT123456789', country: 'Portugal' };
  const us = { id: 23, name: 'Zoom', nif: '', country: 'Estats Units' };
  const r = vatModels({
    years: [{ year: 2026, deductible_vat_pct: 100 }],
    receivedInvoices: [
      doc(1, '2026-01-10', [line(60, 0)]), // domestic 0 %: in 230
      doc(2, '2026-01-11', [line(40, 0)], { reverse_charge: 'none' }), // domestic, reviewed: in 230
      doc(3, '2026-01-12', [line(500, 6)], { contact: pt, vat_special: 'foreign_vat' }), // foreign VAT: not
      doc(4, '2026-01-13', [line(300, 0)], { contact: us, reverse_charge: 'none' }), // from abroad: not
    ],
  }, 2026);

  it('counts only the domestic 0 % purchases', () => {
    expect(r.rows.filter((x) => x.not_in_return).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(r.model390.boxes['230']).toBe(100);
  });
});

// 2026-11-04: a provider from Ireland, with no establishment in Spain, charged
// Spanish VAT (21 %) for an online service. The gestoria's answer: the service
// goes by the reverse charge (arts. 69.Uno.1 and 84.Uno.2 LIVA), so the VAT on
// the invoice is wrongly charged and not deductible (art. 94.Tres, CJEU C-35/05
// Reemtsma); the base is self-assessed in 10/11 and deducted in 36/37 (and goes
// to the model 349); the VAT charged is claimed back from the provider. The
// proposal was «none» (deduct it in 28/29): 37.80 € less to pay than due.
// Figures of a real quarter, made-up names.
describe('Spanish VAT wrongly charged from abroad (wrong_vat)', () => {
  const ie = { id: 31, name: 'Proveïdora de programari', nif: 'IE1234567AB', country: null };
  const us = { id: 32, name: 'Videoconferències Inc', nif: '', country: 'Estats Units' };
  const local = { id: 33, name: 'Programari local SL', nif: 'B12345678', country: null };
  const data = (pct, extra = {}) => ({
    years: [{ year: 2026, deductible_vat_pct: pct }],
    emittedInvoices: [
      doc(1, '2026-10-26', [line(1645.53, 21)], { total_vat: 345.56 }),
      doc(2, '2026-10-26', [line(1975, 21)]),
    ],
    receivedInvoices: [
      doc(10, '2026-10-06', [line(17, 21)], { contact: local }),
      doc(11, '2026-10-31', [line(180, 21)], { contact: ie, ...extra }),
    ],
  });
  const row = (r, id) => r.rows.find((x) => x.kind === 'received-invoices' && x.id === id);

  it('is proposed for a provider from abroad charging a Spanish rate, and stays out until classified', () => {
    const r = vatModels(data(100), 2026);
    expect(row(r, 11)).toMatchObject({ issue: 'received-foreign-vat', proposal: 'wrong_vat', classify: { field: 'vat_special', value: null } });
    expect(r.quarters[3].boxes).toMatchObject({ '10': 0, '28': 17, '29': 3.57 });
  });

  it('self-assesses the base in 10/11 and deducts it in 36/37, not the VAT on the invoice', () => {
    const r = vatModels(data(100, { vat_special: 'wrong_vat' }), 2026);
    expect(row(r, 11)).toMatchObject({
      accrued_boxes: ['10', '11'], base_box: '36', vat_box: '37', reverse_charge: 'intracom', self_rate: 21, self_vat: 37.8, deductible_vat: 37.8,
    });
    const b = r.quarters[3].boxes;
    expect(b).toMatchObject({
      '07': 3620.53, '09': 760.31, '10': 180, '11': 37.8, '12': 0, '13': 0,
      '28': 17, '29': 3.57, '36': 180, '37': 37.8,
    });
    expect(b['27']).toBeCloseTo(798.11, 2);
    expect(b['45']).toBeCloseTo(41.37, 2);
    // the same result as without the invoice: what is self-assessed is deducted
    expect(b['71']).toBeCloseTo(756.74, 2);
    // the 390: an intra-EU acquisition of services at 21 %
    expect(r.model390.boxes).toMatchObject({ '551': 180, '552': 37.8 });
  });

  it('deducts the self-assessed VAT at the year\'s % (prorrata)', () => {
    const r = vatModels(data(80, { vat_special: 'wrong_vat' }), 2026);
    expect(row(r, 11)).toMatchObject({ self_vat: 37.8, deductible_vat: 30.24 });
    expect(r.quarters[3].boxes).toMatchObject({ '11': 37.8, '37': 30.24 });
  });

  it('from outside the EU goes to 12/13 and 28/29', () => {
    const d = data(100);
    d.receivedInvoices[1] = doc(11, '2026-10-31', [line(180, 21)], { contact: us, vat_special: 'wrong_vat' });
    const r = vatModels(d, 2026);
    expect(row(r, 11)).toMatchObject({ accrued_boxes: ['12', '13'], base_box: '28', vat_box: '29', reverse_charge: 'isp' });
    expect(r.quarters[3].boxes).toMatchObject({ '10': 0, '12': 180, '13': 37.8, '28': 197, '29': 41.37 });
    expect(r.quarters[3].boxes['71']).toBeCloseTo(756.74, 2);
  });

  it('can be classified through vat_special', () => {
    const { classifyWrites } = require('../src/api/treasury/services/vat-classify');
    expect(classifyWrites([{ kind: 'received-invoices', id: 11, field: 'vat_special', value: 'wrong_vat' }])).toEqual({
      'received-invoices': [{ id: 11, data: { vat_special: 'wrong_vat' } }],
    });
  });
});

// 2026-11-04, comparing a real 2025 with the returns filed through another
// program: invoices entered after a quarter was filed (and one amount changed)
// left the 390, built from the documents as they are now, not adding up the
// 303s filed — and nothing said so. Figures of that year, rounded down.
describe('the 390 against the 303s filed', () => {
  const { documentSnapshot } = require('../src/api/treasury/services/vat-models');
  const ie = { id: 41, name: 'Servidors', nif: 'DE123456789', country: null };
  const base = () => ({
    years: [{ year: 2025, deductible_vat_pct: 100 }],
    emittedInvoices: [
      doc(1, '2025-02-28', [line(20808.25, 21)]),
      doc(2, '2025-05-31', [line(11133.5, 21)]),
      doc(3, '2025-09-30', [line(21935, 21)]),
      doc(4, '2025-12-05', [line(8932.16, 21)]),
    ],
    receivedInvoices: [doc(10, '2025-10-02', [line(17, 21)])],
    returns: [],
    today: '2026-11-04',
  });
  // every quarter marked as filed with what the documents said then
  const fileAll = (data) => {
    const r = vatModels(data, 2025);
    data.returns = r.quarters.map((q) => ({
      id: q.quarter, model: '303', year: 2025, period: q.period, declaration_type: 'I', boxes: { ...q.boxes },
      documents: documentSnapshot(r.rows.filter((x) => x.quarter === q.quarter)),
    }));
    return data;
  };

  it('says nothing is wrong when no 303 is marked as filed', () => {
    expect(vatModels(base(), 2025).check390).toBe(null);
  });

  it('adds up when the documents did not change', () => {
    const r = vatModels(fileAll(base()), 2025);
    expect(r.check390).toMatchObject({ ok: true, changed: [], unfiled: [] });
    expect(r.check390.result).toBe(r.check390.filed_result);
  });

  it('lists the quarters whose documents changed after filing, and the result filed against the 390’s', () => {
    const d = fileAll(base());
    d.emittedInvoices[2] = doc(3, '2025-09-30', [line(21935.5, 21)]); // corrected after filing
    d.receivedInvoices.push(doc(11, '2025-12-15', [line(65.07, 21)], { contact: ie, vat_special: 'wrong_vat' })); // entered late
    const r = vatModels(d, 2025);
    expect(r.check390.ok).toBe(false);
    expect(r.check390.changed.map((c) => c.period)).toEqual(['3T', '4T']);
    expect(r.check390.changed[0].boxes).toEqual(expect.arrayContaining([
      { box: '07', filed: 21935, now: 21935.5 },
      { box: '09', filed: 4606.35, now: 4606.46 },
    ]));
    expect(r.check390.changed[1].boxes.map((b) => b.box)).toEqual(expect.arrayContaining(['10', '11', '36', '37']));
    // the late invoice self-assesses what it deducts: only the corrected one moves the result
    expect(round(r.check390.result - r.check390.filed_result)).toBe(0.11);
  });

  it('names the quarters not marked as filed, without a result to compare', () => {
    const d = fileAll(base());
    d.returns = d.returns.filter((x) => x.period !== '2T');
    const r = vatModels(d, 2025);
    expect(r.check390).toMatchObject({ ok: false, unfiled: ['2T'], filed_result: null });
  });

  // validation of 2026-11-04: in the middle of the year the quarters still to
  // come were listed as not filed, and the year said the 390 did not add up
  it('does not count a quarter still within its term as missing', () => {
    const d = base();
    for (const x of d.emittedInvoices) x.emitted = x.emitted.replace('2025', '2026');
    d.years = [{ year: 2026, deductible_vat_pct: 100 }];
    d.receivedInvoices = [];
    const r0 = vatModels(d, 2026);
    d.returns = r0.quarters.slice(0, 3).map((q) => ({ id: q.quarter, model: '303', year: 2026, period: q.period, declaration_type: 'I', boxes: { ...q.boxes } }));
    // 4 November: the 4T is due on 30 January
    expect(vatModels(d, 2026).check390).toMatchObject({ ok: true, changed: [], unfiled: [], filed_result: null });
    // 25 October with the 3T not filed: its term (20 October) is over
    d.returns = d.returns.slice(0, 2);
    expect(vatModels({ ...d, today: '2026-10-25' }, 2026).check390).toMatchObject({ ok: false, unfiled: ['3T'] });
    expect(vatModels({ ...d, today: '2026-10-20' }, 2026).check390).toMatchObject({ ok: true, unfiled: [] });
  });
});

// 2026-11-04: the self-employed quota, entered as a received invoice at 0 %,
// went to the 390's 230 (domestic exempt purchases): it is no purchase at all.
describe('received lines outside VAT (not_vat)', () => {
  const ss = { id: 51, name: 'Seguretat Social', nif: '', country: null };
  const r = vatModels({
    years: [{ year: 2025, deductible_vat_pct: 100 }],
    receivedInvoices: [
      doc(1, '2025-01-31', [line(624, 0)], { contact: ss, reverse_charge: 'not_vat' }),
      doc(2, '2025-02-28', [line(624, 0)], { contact: { ...ss, id: 52, name: 'Assegurança' } }), // not classified yet: an exempt purchase
      doc(3, '2025-03-10', [line(40, 0)], { reverse_charge: 'none' }), // insurance: exempt
    ],
  }, 2025);
  const row = (id) => r.rows.find((x) => x.id === id);

  it('leaves them out of the return and of the 230', () => {
    expect(row(1)).toMatchObject({ not_in_return: true, not_vat: true, classify: { field: 'reverse_charge', value: 'not_vat' } });
    expect(row(1).annual_box).toBeUndefined();
    expect(row(2)).toMatchObject({ annual_box: '230' });
    expect(row(3)).toMatchObject({ annual_box: '230' });
    expect(r.model390.boxes['230']).toBe(664);
  });

  it('proposes it again for the same contact, out of the 230 until classified', () => {
    const r2 = vatModels({
      years: [{ year: 2025, deductible_vat_pct: 100 }],
      receivedInvoices: [
        doc(1, '2025-01-31', [line(624, 0)], { contact: ss, reverse_charge: 'not_vat' }),
        doc(2, '2025-02-28', [line(624, 0)], { contact: ss }),
      ],
      history: { received: [] },
    }, 2025);
    expect(r2.rows.find((x) => x.id === 2)).toMatchObject({ issue: 'received-not-vat', proposal: 'not_vat' });
    expect(r2.rows.find((x) => x.id === 2).annual_box).toBeUndefined();
    expect(r2.model390.boxes['230']).toBe(0);
    expect(r2.issues.map((i) => i.code)).toEqual(['received-not-vat']);
  });

  it('is classified without a self-assessed rate', () => {
    const { classifyWrites } = require('../src/api/treasury/services/vat-classify');
    expect(classifyWrites([{ kind: 'received-invoices', id: 1, value: 'not_vat' }])).toEqual({
      'received-invoices': [{ id: 1, data: { reverse_charge: 'not_vat' } }],
    });
  });
});
