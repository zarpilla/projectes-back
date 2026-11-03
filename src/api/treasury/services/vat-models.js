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
 *   Lines at 4, 10 and 21 % go to their rate's boxes. An invoice of a
 *   rectifying series goes to 14/15 (modificació de bases).
 * - Received invoices, by emission date: VAT paid in domestic operations
 *   (28/29, or 30/31 for lines of an expense type of capital goods), the quota
 *   after the year's «% IVA deduïble» (prorrata; an empty year is 100 %,
 *   issues/338). The base is the whole base.
 * - Expenses (tiquets, dietes…) do not count: listed apart.
 * - Cash accounting, equivalence surcharge, REAGP and OSS are not supported:
 *   the page says so.
 *
 * The lines at 0 % follow their document's classification (phase 2):
 * - issued `vat_operation`, Verifactu's codes: E1 exempt (art. 20, annual 83),
 *   E2 export (60, annual 94), E5 intra-EU supply (59, annual 93), N1 not
 *   subject (outside the return), N2 not subject by place of supply (120,
 *   annual 84), S2 reverse charge (122, annual 125);
 * - received `reverse_charge`: intracom = self-assessed intra-EU acquisition
 *   (10/11, deducted in 36/37 or 38/39), isp = other reverse charge (12/13,
 *   deducted in 28/29 or 30/31), at `reverse_charge_rate` (21 % by default);
 *   none = reviewed, nothing to self-assess.
 * Unclassified ones are listed for review with a proposal: what the same
 * contact's last classified document had, or one from its country.
 *
 * Each line's base and VAT are rounded to cents, as the documents compute them
 * (front domain/documentTotals.js), and the cents a document's stored totals
 * differ by go to its main group (documentGroups).
 */

// issued: rate → [base, tipus, quota]
const RATE_BOXES = {
  4: ['01', '02', '03'],
  10: ['04', '05', '06'],
  21: ['07', '08', '09'],
};

// issued 0 % lines by classification: the 303 box (information) and the 390's
const OPERATIONS = {
  E1: { box: null, annual: '83' },
  E2: { box: '60', annual: '94' },
  E5: { box: '59', annual: '93' },
  N1: { box: null, annual: null },
  N2: { box: '120', annual: '84' },
  S2: { box: '122', annual: '125' },
};
const REVERSE_CHARGES = ['none', 'intracom', 'isp'];

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
const isCapital = (l) => !!(l.expense_type && l.expense_type.capital_goods);

// a document's lines per VAT rate (and, received, capital goods or not):
// [{ rate, capital, base, vat }]
function byRate(lines, withCapital = false) {
  const groups = new Map();
  for (const l of lines || []) {
    const rate = Number(l.vat) || 0;
    const capital = withCapital && isCapital(l);
    const key = `${rate}:${capital}`;
    const g = groups.get(key) || { rate, capital, base: 0, vat: 0 };
    g.base = round2(g.base + lineBase(l));
    g.vat = round2(g.vat + lineVat(l));
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.base || g.vat);
}

/**
 * The document's groups, matching its stored totals: when the lines add up to
 * a few cents more or less than total_base / total_vat (lines with 4-decimal
 * prices, issues/194), the difference goes to the group with the largest
 * base, so the return adds up what the invoices say.
 */
function documentGroups(doc, withCapital = false) {
  const groups = byRate(doc.lines, withCapital);
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
    contact_id: doc.contact && doc.contact.id ? doc.contact.id : null,
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

const issuedProposal = (area) => (area === 'ES' ? null : 'N2');
const receivedProposal = (area) => (area === 'EU' ? 'intracom' : area === 'NONEU' ? 'isp' : null);

/**
 * What to propose for an unclassified document: the classification of the
 * same contact's latest classified document on the same side, or one from its
 * country (services abroad: not subject by place of supply; purchases: an
 * intra-EU acquisition from the EU, a reverse charge from outside).
 */
function proposals(docs, field, byArea) {
  const latest = new Map();
  for (const d of [...docs].sort((a, b) => String(a.emitted).localeCompare(String(b.emitted)))) {
    if (d[field] && d.contact && d.contact.id) latest.set(d.contact.id, d[field]);
  }
  return (doc) => (doc.contact && latest.get(doc.contact.id)) || byArea(contactArea(doc.contact));
}

/**
 * The rows: one per document and VAT rate, with the boxes it goes to.
 * `issue` marks the rows that need a decision (they are in no box);
 * `classify` says which field classifies the row, with its value.
 * `history` (optional): earlier classified documents, for the proposals.
 */
function documentRows({ emittedInvoices = [], receivedIncomes = [], receivedInvoices = [], history = {} }, years) {
  const rows = [];
  const issuedDocs = [
    ...emittedInvoices.filter((d) => d.state !== 'draft').map((d) => ['emitted-invoices', d]),
    ...receivedIncomes.map((d) => ['received-incomes', d]),
  ];
  const proposeIssued = proposals(
    [...issuedDocs.map(([, d]) => d), ...(history.issued || [])],
    'vat_operation',
    issuedProposal,
  );
  for (const [kind, doc] of issuedDocs) {
    if (!doc.emitted) continue;
    const info = docInfo(doc, kind);
    const rectificative = !!(doc.serial && doc.serial.rectificative);
    for (const g of documentGroups(doc)) {
      const row = { ...info, key: `${kind}:${doc.id}:${g.rate}`, side: 'issued', rate: g.rate, base: g.base, vat: g.vat, rectificative };
      if (rectificative && g.rate) Object.assign(row, { base_box: '14', vat_box: '15' });
      else if (g.rate === 0) {
        const op = OPERATIONS[doc.vat_operation] ? doc.vat_operation : null;
        Object.assign(row, { classify: { field: 'vat_operation', value: op } });
        if (!op) Object.assign(row, { issue: 'issued-zero', proposal: proposeIssued(doc) });
        else if (OPERATIONS[op].box) Object.assign(row, { info_box: OPERATIONS[op].box });
        else Object.assign(row, { not_in_return: true });
        if (op) row.annual_box = OPERATIONS[op].annual;
      } else if (RATE_BOXES[g.rate]) Object.assign(row, { base_box: RATE_BOXES[g.rate][0], vat_box: RATE_BOXES[g.rate][2] });
      else Object.assign(row, { issue: 'unknown-rate' });
      rows.push(row);
    }
  }

  const proposeReceived = proposals([...receivedInvoices, ...(history.received || [])], 'reverse_charge', receivedProposal);
  for (const doc of receivedInvoices) {
    if (!doc.emitted) continue;
    const info = docInfo(doc, 'received-invoices');
    const pct = deductiblePct(years, info.year);
    for (const g of documentGroups(doc, true)) {
      const row = {
        ...info,
        key: `received-invoices:${doc.id}:${g.rate}:${g.capital ? 'k' : 'c'}`,
        side: 'received',
        rate: g.rate,
        capital: g.capital,
        base: g.base,
        vat: g.vat,
        deductible_pct: pct,
        deductible_vat: round2((g.vat * pct) / 100),
      };
      if (g.rate > 0) {
        Object.assign(row, g.capital ? { base_box: '30', vat_box: '31' } : { base_box: '28', vat_box: '29' });
        rows.push(row);
        continue;
      }
      const rc = REVERSE_CHARGES.includes(doc.reverse_charge) ? doc.reverse_charge : null;
      row.classify = { field: 'reverse_charge', value: rc };
      if (rc === 'intracom' || rc === 'isp') {
        // self-assessed: charged and deducted at the same time
        const rate = doc.reverse_charge_rate === null || doc.reverse_charge_rate === undefined || doc.reverse_charge_rate === ''
          ? 21
          : Number(doc.reverse_charge_rate);
        const vat = round2((g.base * rate) / 100);
        Object.assign(row, {
          self_rate: rate,
          self_vat: vat,
          deductible_vat: round2((vat * pct) / 100),
          accrued_boxes: rc === 'intracom' ? ['10', '11'] : ['12', '13'],
        });
        if (rc === 'intracom') Object.assign(row, g.capital ? { base_box: '38', vat_box: '39' } : { base_box: '36', vat_box: '37' });
        else Object.assign(row, g.capital ? { base_box: '30', vat_box: '31' } : { base_box: '28', vat_box: '29' });
      } else if (rc === 'none') row.not_in_return = true;
      // a 0 % purchase from abroad may be a reverse charge the entity has to self-assess
      else if (info.area !== 'ES') Object.assign(row, { issue: 'received-foreign-zero', proposal: proposeReceived(doc) });
      else row.not_in_return = true;
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
    if (r.accrued_boxes) {
      b[r.accrued_boxes[0]] += r.base;
      b[r.accrued_boxes[1]] += r.self_vat;
    }
    if (r.info_box) b[r.info_box] += r.base;
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
  'issued-zero': 'Línies emeses al 0 % sense classificar: poden ser exemptes, no subjectes, entregues intracomunitàries (59), exportacions (60), no subjectes per localització (120) o amb inversió del subjecte passiu (122). Fins que no es classifiquen no són a cap casella.',
  'unknown-rate': 'Línies emeses a un tipus que el 303 no té (només 4, 10 i 21 %). No són a cap casella.',
  'received-foreign-zero': "Factures rebudes de fora d'Espanya al 0 %: si és una compra intracomunitària o un servei de fora, cal autoliquidar l'IVA (caselles 10/11 i 36/37, o 12/13 i 28/29). Fins que no es classifiquen no són a cap casella.",
};

/**
 * The year's 390 figures from its rows: the volume of operations by kind and
 * an estimate of the final prorrata (operations with a right to deduct over
 * all of them, rounded up), with the box 44 regularisation it would bring.
 * Information only: the gestoria decides.
 */
function annualFigures(rows, annual, pct) {
  const sum = (box) => round2(rows.filter((r) => r.annual_box === box).reduce((s, r) => s + r.base, 0));
  const figures = { '83': sum('83'), '84': sum('84'), '93': sum('93'), '94': sum('94'), '125': sum('125') };
  figures['80'] = round2(['150', '01', '04', '07', '14'].reduce((s, k) => s + annual[k], 0));
  figures['88'] = round2(figures['80'] + figures['83'] + figures['84'] + figures['93'] + figures['94'] + figures['125']);
  const withRight = figures['88'] - figures['83'];
  let prorrata = null;
  if (figures['88'] > 0 && figures['83'] > 0) {
    const definitive = Math.min(100, Math.ceil((withRight / figures['88']) * 100));
    // the VAT paid before the provisional prorrata, applied again with the final one
    const paid = rows.filter((r) => r.side === 'received' && r.base_box).reduce((s, r) => s + (r.self_vat !== undefined ? r.self_vat : r.vat), 0);
    prorrata = {
      provisional: pct,
      definitive,
      regularisation: round2((paid * (definitive - pct)) / 100),
    };
  }
  return { figures, prorrata };
}

/**
 * @param {object} data { emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses, years, history }
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
  const unclassified = rows.filter((r) => r.issue === 'issued-zero' || r.issue === 'unknown-rate');
  annual.unclassified_base = round2(unclassified.reduce((s, r) => s + r.base, 0));
  const { figures, prorrata } = annualFigures(rows, annual, pct);
  Object.assign(annual, figures);

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
      text: `L'IVA suportat es dedueix al ${pct} % (prorrata de l'any, Configuració › Anys). La regularització amb la prorrata definitiva del 4T (casella 44) no es posa al model: a «Any (390)» se n'hi mostra una estimació.`,
    });
  }
  notes.push({
    code: 'compensation',
    text: "Les quotes a compensar (110) només porten els resultats negatius dels trimestres d'aquest any. Si al 4T de l'any anterior vau triar compensar, cal sumar-ho al T1.",
  });
  notes.push({
    code: 'unsupported',
    text: "No es contemplen el criteri de caixa, el recàrrec d'equivalència, el règim d'agricultura (REAGP), la finestreta única (OSS), les importacions ni les rectificacions de factures rebudes (40/41).",
  });

  return {
    year,
    deductible_pct: pct,
    quarters,
    annual,
    prorrata,
    issues,
    notes,
    rows,
  };
}

module.exports = { vatModels, contactArea, documentRows, periodBoxes, deductiblePct, OPERATIONS, REVERSE_CHARGES };
