'use strict';

const moment = require('moment');
const { round2 } = require('./balances');
const { vatPaymentDate } = require('./vat-forecast');

/**
 * Models 303 i 390 (Beta): the boxes of the AEAT VAT return for each quarter of
 * a year, and their sum for the year, from the issued and received invoices.
 *
 * What counts (decided 2026-11-03):
 * - Issued invoices (not drafts) and incomes, by emission date: VAT charged.
 *   Lines at 4, 10 and 21 % go to their rate's boxes, 0 % to 150–152. An
 *   invoice of a rectifying series goes to 14/15 (modificació de bases).
 * - Received invoices, by emission date: VAT paid in domestic operations
 *   (28/29), the quota after the year's «% IVA deduïble» (prorrata; an empty
 *   year is 100 %, issues/338). The base is the whole base.
 * - Expenses (tiquets, dietes…) do not count: listed apart.
 * - Cash accounting, equivalence surcharge, REAGP and OSS are not supported:
 *   the page says so.
 *
 * Lines at 0 % are not classified yet (exempt, not subject, intra-EU,
 * export…): they are listed as warnings with the contact's country, and so
 * are 0 % received invoices from abroad (possible reverse charge, 10/11 and
 * 36/37) and rates the return has no box for.
 *
 * Each line's base and VAT are rounded to cents, as the documents compute them
 * (front domain/documentTotals.js), and the cents a document's stored totals
 * differ by go to its main rate (documentRates).
 */

// issued: rate → [base, tipus, quota]
const RATE_BOXES = {
  0: ['150', '151', '152'],
  4: ['01', '02', '03'],
  10: ['04', '05', '06'],
  21: ['07', '08', '09'],
};

const ISSUED_KINDS = ['emitted-invoices', 'received-incomes'];

// compared without accents nor case (contacts' country is free text)
const plain = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

const SPAIN = ['', 'es', 'esp', 'espanya', 'espana', 'spain', 'catalunya', 'cataluna', 'paisos catalans'];
// EU member states, as written in the contacts (Catalan, Spanish, English…), by VAT prefix
const EU = {
  AT: ['austria'],
  BE: ['belgica', 'belgium'],
  BG: ['bulgaria'],
  CY: ['xipre', 'chipre', 'cyprus'],
  CZ: ['txequia', 'republica txeca', 'republica checa', 'czechia', 'czech republic'],
  DE: ['alemanya', 'alemania', 'germany', 'deutschland'],
  DK: ['dinamarca', 'denmark'],
  EE: ['estonia'],
  EL: ['grecia', 'greece'],
  FI: ['finlandia', 'finland'],
  FR: ['franca', 'francia', 'france'],
  HR: ['croacia', 'croatia'],
  HU: ['hongria', 'hungria', 'hungary'],
  IE: ['irlanda', 'ireland'],
  IT: ['italia', 'italy'],
  LT: ['lituania', 'lithuania'],
  LU: ['luxemburg', 'luxemburgo', 'luxembourg'],
  LV: ['letonia', 'latvia', 'letvia'],
  MT: ['malta'],
  NL: ['paisos baixos', 'paises bajos', 'holanda', 'netherlands', 'the netherlands'],
  PL: ['polonia', 'poland'],
  PT: ['portugal'],
  RO: ['romania', 'rumania'],
  SE: ['suecia', 'sweden'],
  SI: ['eslovenia', 'slovenia'],
  SK: ['eslovaquia', 'slovakia', 'slovakija'],
};
const EU_NAMES = Object.values(EU).flat();

/**
 * Where a contact is: 'ES', 'EU' or 'NONEU' (outside the EU, or a country
 * not recognised), from its VAT number's prefix or its country. No country is
 * Spain.
 */
function contactArea(contact) {
  const nif = String((contact && contact.nif) || '').replace(/[\s.-]/g, '').toUpperCase();
  const prefix = /^[A-Z]{2}[0-9A-Z]/.test(nif) ? nif.slice(0, 2) : null;
  if (prefix === 'ES') return 'ES';
  if (prefix && EU[prefix]) return 'EU';
  const country = plain(contact && contact.country);
  if (SPAIN.includes(country)) return 'ES';
  if (EU_NAMES.includes(country)) return 'EU';
  return 'NONEU';
}

const lineBase = (l) => round2((Number(l.quantity) || 0) * (Number(l.base) || 0) * (1 - (Number(l.discount) || 0) / 100));
const lineVat = (l) => round2((lineBase(l) * (Number(l.vat) || 0)) / 100);

// a document's lines per VAT rate: [{ rate, base, vat }]
function byRate(lines) {
  const groups = new Map();
  for (const l of lines || []) {
    const rate = Number(l.vat) || 0;
    const g = groups.get(rate) || { rate, base: 0, vat: 0 };
    g.base = round2(g.base + lineBase(l));
    g.vat = round2(g.vat + lineVat(l));
    groups.set(rate, g);
  }
  return [...groups.values()].filter((g) => g.base || g.vat);
}

/**
 * The document's rates, matching its stored totals: when the lines add up to
 * a few cents more or less than total_base / total_vat (lines with 4-decimal
 * prices, issues/194), the difference goes to the rate with the largest base,
 * so the return adds up what the invoices say.
 */
function documentRates(doc) {
  const groups = byRate(doc.lines);
  if (!groups.length) return groups;
  const main = groups.reduce((a, g) => (Math.abs(g.base) > Math.abs(a.base) ? g : a), groups[0]);
  for (const [field, total] of [['base', doc.total_base], ['vat', doc.total_vat]]) {
    if (total === null || total === undefined || total === '') continue;
    const diff = round2(Number(total) - groups.reduce((s, g) => s + g[field], 0));
    if (diff && Math.abs(diff) < 1 && (field === 'base' || main.rate)) main[field] = round2(main[field] + diff);
  }
  return groups;
}

// the year's «% IVA deduïble» (an empty year is 100 %, issues/338)
function deductiblePct(years, year) {
  const y = (years || []).find((x) => Number(x.year) === Number(year));
  return y && y.deductible_vat_pct !== null && y.deductible_vat_pct !== undefined && y.deductible_vat_pct !== ''
    ? Number(y.deductible_vat_pct)
    : 100;
}

function docInfo(doc, kind) {
  const m = moment(doc.emitted, 'YYYY-MM-DD');
  return {
    kind,
    id: doc.id,
    code: doc.code || '',
    contact: doc.contact && doc.contact.name ? doc.contact.name : '',
    nif: doc.contact && doc.contact.nif ? doc.contact.nif : '',
    country: doc.contact && doc.contact.country ? doc.contact.country : '',
    area: contactArea(doc.contact),
    date: doc.emitted,
    year: m.year(),
    quarter: m.quarter(),
    to: `/document/${doc.id}/${kind}`,
  };
}

/**
 * The rows: one per document and VAT rate, with the boxes it goes to.
 * `issue` marks the rows that need a decision (they are in no box).
 */
function documentRows({ emittedInvoices = [], receivedIncomes = [], receivedInvoices = [] }, years) {
  const rows = [];
  const issued = [
    ...emittedInvoices.filter((d) => d.state !== 'draft').map((d) => ['emitted-invoices', d]),
    ...receivedIncomes.map((d) => ['received-incomes', d]),
  ];
  for (const [kind, doc] of issued) {
    if (!doc.emitted) continue;
    const info = docInfo(doc, kind);
    const rectificative = !!(doc.serial && doc.serial.rectificative);
    for (const g of documentRates(doc)) {
      const row = { ...info, key: `${kind}:${doc.id}:${g.rate}`, side: 'issued', rate: g.rate, base: g.base, vat: g.vat, rectificative };
      if (rectificative) Object.assign(row, { base_box: '14', vat_box: '15' });
      else if (g.rate === 0) Object.assign(row, { issue: 'issued-zero' });
      else if (RATE_BOXES[g.rate]) Object.assign(row, { base_box: RATE_BOXES[g.rate][0], vat_box: RATE_BOXES[g.rate][2] });
      else Object.assign(row, { issue: 'unknown-rate' });
      rows.push(row);
    }
  }
  for (const doc of receivedInvoices) {
    if (!doc.emitted) continue;
    const info = docInfo(doc, 'received-invoices');
    const pct = deductiblePct(years, info.year);
    for (const g of documentRates(doc)) {
      const row = {
        ...info,
        key: `received-invoices:${doc.id}:${g.rate}`,
        side: 'received',
        rate: g.rate,
        base: g.base,
        vat: g.vat,
        deductible_pct: pct,
        deductible_vat: round2((g.vat * pct) / 100),
      };
      if (g.rate > 0) Object.assign(row, { base_box: '28', vat_box: '29' });
      // a 0 % purchase from abroad may be a reverse charge the entity has to self-assess
      else if (info.area !== 'ES') Object.assign(row, { issue: 'received-foreign-zero' });
      else Object.assign(row, { not_in_return: true });
      rows.push(row);
    }
  }
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.code.localeCompare(b.code));
}

const ALL_BOXES = [
  '150', '151', '152', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15',
  '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45',
  '46', '64', '65', '66', '110', '78', '87', '69', '71', '59', '60', '120', '122',
];

function emptyBoxes() {
  const boxes = {};
  for (const b of ALL_BOXES) boxes[b] = 0;
  return boxes;
}

// the boxes of one period from its rows; `compensate` = box 110
function periodBoxes(rows, compensate) {
  const b = emptyBoxes();
  for (const r of rows) {
    if (!r.base_box) continue;
    b[r.base_box] += r.base;
    b[r.vat_box] += r.side === 'received' ? r.deductible_vat : r.vat;
  }
  b['151'] = 0;
  b['02'] = 4;
  b['05'] = 10;
  b['08'] = 21;
  b['27'] = b['152'] + b['03'] + b['06'] + b['09'] + b['11'] + b['13'] + b['15'];
  b['45'] = b['29'] + b['31'] + b['33'] + b['35'] + b['37'] + b['39'] + b['41'] + b['42'] + b['43'] + b['44'];
  b['46'] = b['27'] - b['45'];
  b['64'] = b['46'];
  b['65'] = 100;
  b['66'] = b['64'];
  b['110'] = compensate;
  // what is pending from earlier periods is applied up to this period's result
  b['78'] = Math.min(compensate, Math.max(b['66'], 0));
  b['87'] = compensate - b['78'];
  b['69'] = b['66'] - b['78'];
  b['71'] = b['69'];
  for (const k of Object.keys(b)) b[k] = round2(b[k]);
  return b;
}

const ISSUE_TEXT = {
  'issued-zero': 'Línies emeses al 0 % sense classificar: poden ser exemptes, no subjectes, entregues intracomunitàries (59), exportacions (60) o no subjectes per localització (120). No són a cap casella.',
  'unknown-rate': 'Línies emeses a un tipus que el 303 no té (només 0, 4, 10 i 21 %). No són a cap casella.',
  'received-foreign-zero': "Factures rebudes de fora d'Espanya al 0 %: si és una compra intracomunitària o un servei de fora, cal autoliquidar l'IVA (caselles 10/11 i 36/37, o 12/13 i 28/29). No s'hi han posat.",
};

/**
 * @param {object} data { emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses, years }
 * @param {number} year
 */
function vatModels(data, year) {
  year = Number(year);
  const rows = documentRows(data, data.years).filter((r) => r.year === year);
  const pct = deductiblePct(data.years, year);

  let carry = 0;
  const quarters = [1, 2, 3, 4].map((quarter) => {
    const qRows = rows.filter((r) => r.quarter === quarter);
    const boxes = periodBoxes(qRows, carry);
    // a negative result of T1–T3 is compensated in the next quarters
    carry = quarter < 4 ? round2(boxes['87'] + Math.max(-boxes['71'], 0)) : 0;
    return {
      quarter,
      deadline: vatPaymentDate(year, quarter).format('YYYY-MM-DD'),
      documents: new Set(qRows.map((r) => `${r.kind}:${r.id}`)).size,
      boxes,
    };
  });

  // the year: the sum of the quarters' bases and quotas (390)
  const annual = emptyBoxes();
  for (const q of quarters) for (const k of ALL_BOXES) annual[k] += q.boxes[k];
  for (const k of Object.keys(annual)) annual[k] = round2(annual[k]);
  Object.assign(annual, { '151': 0, '02': 4, '05': 10, '08': 21, '65': 100, '110': 0, '78': 0, '87': 0 });
  annual['69'] = annual['66'];
  annual['71'] = annual['66'];
  // operacions en règim general (80) and what can't be classified yet
  const unclassified = rows.filter((r) => r.issue === 'issued-zero' || r.issue === 'unknown-rate');
  annual['80'] = round2(['150', '01', '04', '07', '14'].reduce((s, k) => s + annual[k], 0));
  annual.unclassified_base = round2(unclassified.reduce((s, r) => s + r.base, 0));

  const issues = Object.keys(ISSUE_TEXT)
    .map((code) => {
      const list = rows.filter((r) => r.issue === code);
      return {
        code,
        text: ISSUE_TEXT[code],
        count: list.length,
        base: round2(list.reduce((s, r) => s + r.base, 0)),
        vat: round2(list.reduce((s, r) => s + r.vat, 0)),
        areas: ['ES', 'EU', 'NONEU']
          .map((area) => ({ area, count: list.filter((r) => r.area === area).length, base: round2(list.filter((r) => r.area === area).reduce((s, r) => s + r.base, 0)) }))
          .filter((a) => a.count),
      };
    })
    .filter((i) => i.count);

  const inYear = (d) => d.emitted && moment(d.emitted, 'YYYY-MM-DD').year() === year;
  const expenses = (data.receivedExpenses || []).filter(inYear);
  const drafts = (data.emittedInvoices || []).filter((d) => d.state === 'draft' && inYear(d));
  const notes = [];
  if (expenses.length) {
    notes.push({
      code: 'expenses-excluded',
      text: "Les despeses (tiquets, dietes i altres) no compten: l'IVA d'un tiquet sense les dades de l'entitat no es pot deduir.",
      count: expenses.length,
      vat: round2(expenses.reduce((s, d) => s + (Number(d.total_vat) || 0), 0)),
    });
  }
  if (drafts.length) {
    notes.push({ code: 'drafts-excluded', text: 'Les factures emeses en esborrany no compten.', count: drafts.length, vat: round2(drafts.reduce((s, d) => s + (Number(d.total_vat) || 0), 0)) });
  }
  if (pct < 100) {
    notes.push({
      code: 'prorrata',
      text: `L'IVA suportat es dedueix al ${pct} % (prorrata de l'any, Configuració › Anys). La regularització amb la prorrata definitiva del 4T (casella 44) no es calcula.`,
    });
  }
  notes.push({
    code: 'compensation',
    text: "Les quotes a compensar (110) només porten els resultats negatius dels trimestres d'aquest any. Si al 4T de l'any anterior vau triar compensar, cal sumar-ho al T1.",
  });
  notes.push({
    code: 'unsupported',
    text: "No es contemplen el criteri de caixa, el recàrrec d'equivalència, el règim d'agricultura (REAGP) ni la finestreta única (OSS).",
  });

  return {
    year,
    deductible_pct: pct,
    quarters,
    annual,
    issues,
    notes,
    rows,
  };
}

module.exports = { vatModels, contactArea, documentRows, periodBoxes, deductiblePct };
