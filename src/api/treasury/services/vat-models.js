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
 * - Cash accounting, equivalence surcharge, simplified regime, OSS, imports,
 *   differentiated sectors and box 43 are not supported: the page says so.
 *
 * The lines at 0 % follow their document's classification (phase 2):
 * - issued `vat_operation`, Verifactu's codes: E1 exempt (art. 20, annual 83),
 *   E2 export (60, annual 94), E5 intra-EU supply (59, annual 93), N1 not
 *   subject (outside the return), N2 not subject by place of supply (120,
 *   annual 84), S2 reverse charge (122, annual 125);
 * - received `reverse_charge`: intracom / intracom_goods = self-assessed
 *   intra-EU acquisition of services / goods (10/11, deducted in 36/37 or
 *   38/39; the 390 tells them apart), isp = other reverse charge (12/13,
 *   deducted in 28/29 or 30/31), at `reverse_charge_rate` (21 % by default);
 *   none = reviewed, nothing to self-assess; not_vat = not a VAT operation at
 *   all (the self-employed quota, taxes, fees…), left out of the 390's 230
 *   (domestic exempt purchases) too.
 * Received lines with VAT at the REAGP rates (12, 10.5 %) or from abroad are
 * classified too (`vat_special`: reagp → 42, foreign_vat → outside the
 * return, none → 28/29, wrong_vat → Spanish VAT charged by a provider without
 * an establishment here instead of the reverse charge: not deductible, the
 * base is self-assessed at the line's rate as intracom (from the EU) or isp). A received invoice with a negative base rectifies
 * deductions: 40/41.
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
// intracom: services (and goods until phase 3); intracom_goods: goods (the 390 tells them apart)
const REVERSE_CHARGES = ['none', 'intracom', 'intracom_goods', 'isp', 'not_vat'];
const INTRACOM = ['intracom', 'intracom_goods'];
// received lines with VAT: none = Spanish VAT, deductible; reagp = the agrarian
// compensation of a farmer in the REAGP (box 42); foreign_vat = another
// country's VAT, not deductible here (refunded through the model 360);
// wrong_vat = Spanish VAT a provider from abroad charged where the reverse
// charge applied (a B2B service: arts. 69.Uno.1, 84.Uno.2 LIVA): not
// deductible (art. 94.Tres, CJEU C-35/05 Reemtsma; the entity claims it back
// from the provider), and the base is self-assessed: 10/11 + 36/37 from the EU
// (also in the model 349), 12/13 + 28/29 from elsewhere. The gestoria's answer
// for webcoop, 2026-11-04.
const VAT_SPECIALS = ['none', 'reagp', 'foreign_vat', 'wrong_vat'];
const REAGP_RATES = [12, 10.5];
const SPANISH_RATES = [2, 4, 5, 7.5, 10, 21];

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

// a received line with VAT that needs a decision: the REAGP rates, and
// VAT from abroad (a Spanish rate is proposed as wrongly charged, the usual
// case of a service from abroad; goods a provider sells from Spain with its
// Spanish VAT number, e.g. Amazon EU, are «none»)
function specialProposal(area, rate) {
  if (REAGP_RATES.includes(rate)) return 'reagp';
  if (area !== 'ES') return SPANISH_RATES.includes(rate) ? 'wrong_vat' : 'foreign_vat';
  return null;
}
// a self-assessed row: charged (10/11 or 12/13) and deducted at the same time
function selfAssessed(rc, base, rate, capital, pct) {
  const vat = round2((base * rate) / 100);
  return {
    self_rate: rate,
    self_vat: vat,
    deductible_vat: round2((vat * pct) / 100),
    accrued_boxes: rc === 'isp' ? ['12', '13'] : ['10', '11'],
    reverse_charge: rc,
    ...(rc !== 'isp'
      ? capital ? { base_box: '38', vat_box: '39' } : { base_box: '36', vat_box: '37' }
      : capital ? { base_box: '30', vat_box: '31' } : { base_box: '28', vat_box: '29' }),
  };
}

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
        const special = VAT_SPECIALS.includes(doc.vat_special) ? doc.vat_special : null;
        const proposal = specialProposal(info.area, g.rate);
        // the agrarian compensation and foreign VAT are classified; the rest as before
        if (special || proposal) row.classify = { field: 'vat_special', value: special };
        if (special === 'reagp') Object.assign(row, { vat_box: '42', reagp: true });
        else if (special === 'foreign_vat') row.not_in_return = true;
        // the VAT on the invoice is not deducted; the base is self-assessed at its rate
        else if (special === 'wrong_vat') Object.assign(row, selfAssessed(info.area === 'EU' ? 'intracom' : 'isp', g.base, g.rate, g.capital, pct));
        else if (!special && proposal) Object.assign(row, { issue: proposal === 'reagp' ? 'received-reagp' : 'received-foreign-vat', proposal });
        // a received rectifying invoice (negative) rectifies deductions: 40/41
        else if (doc.total_base !== null && doc.total_base !== undefined && Number(doc.total_base) < 0) Object.assign(row, { base_box: '40', vat_box: '41' });
        else Object.assign(row, g.capital ? { base_box: '30', vat_box: '31' } : { base_box: '28', vat_box: '29' });
        rows.push(row);
        continue;
      }
      const rc = REVERSE_CHARGES.includes(doc.reverse_charge) ? doc.reverse_charge : null;
      row.classify = { field: 'reverse_charge', value: rc };
      if (INTRACOM.includes(rc) || rc === 'isp') {
        // self-assessed: charged and deducted at the same time
        const rate = doc.reverse_charge_rate === null || doc.reverse_charge_rate === undefined || doc.reverse_charge_rate === ''
          ? 21
          : Number(doc.reverse_charge_rate);
        Object.assign(row, selfAssessed(rc, g.base, rate, g.capital, pct));
      } else if (rc === 'not_vat') Object.assign(row, { not_in_return: true, not_vat: true });
      // a domestic 0 % purchase is an exempt one (390: 230), unless it is no VAT operation at all
      else if (rc === 'none') Object.assign(row, { not_in_return: true }, info.area === 'ES' ? { annual_box: '230' } : {});
      // a 0 % purchase from abroad may be a reverse charge the entity has to self-assess
      else if (info.area !== 'ES') Object.assign(row, { issue: 'received-foreign-zero', proposal: proposeReceived(doc) });
      else Object.assign(row, { not_in_return: true, annual_box: '230' });
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

// the boxes of one period from its rows; `compensate` = box 110; `extra`:
// boxes set from outside the rows (44, the final prorrata in the last quarter)
function periodBoxes(rows, compensate, extra = {}) {
  const b = emptyBoxes();
  Object.assign(b, extra);
  for (const r of rows) {
    if (r.accrued_boxes) {
      b[r.accrued_boxes[0]] += r.base;
      b[r.accrued_boxes[1]] += r.self_vat;
    }
    if (r.info_box) b[r.info_box] += r.base;
    if (r.base_box) b[r.base_box] += r.base;
    // 42 (agrarian compensation) has a quota only
    if (r.vat_box) b[r.vat_box] += r.side === 'received' ? r.deductible_vat : r.vat;
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
  'received-reagp': "Factures rebudes al 12 % o al 10,5 %: si són d'un pagès en el règim especial agrari (REAGP), és la compensació a tant alçat, que es dedueix a la casella 42. Fins que no es classifiquen no són a cap casella.",
  'received-foreign-vat': "Factures rebudes de fora d'Espanya amb IVA: l'IVA d'un altre país no es dedueix al 303 (es recupera amb el model 360). Si un proveïdor sense establiment a Espanya (Anthropic, Zoom, Canva…) cobra IVA espanyol per un servei, l'IVA està mal repercutit: no es dedueix, la base s'autoliquida (10/11 i 36/37 si és de la UE, que també van al model 349; 12/13 i 28/29 si és de fora) i l'IVA cobrat es reclama al proveïdor amb una factura rectificativa. Si el proveïdor ven des d'Espanya amb NIF espanyol (p. ex. Amazon EU), és IVA espanyol deduïble. Fins que no es classifiquen no són a cap casella.",
  'received-foreign-zero': "Factures rebudes de fora d'Espanya al 0 %: si és una compra intracomunitària o un servei de fora, cal autoliquidar l'IVA (caselles 10/11 i 36/37, o 12/13 i 28/29). Fins que no es classifiquen no són a cap casella.",
};

/**
 * The year's 390 figures from its rows: the volume of operations by kind and
 * an estimate of the final prorrata (operations with a right to deduct over
 * all of them, rounded up), with the box 44 regularisation it would bring.
 * Information only: the gestoria decides.
 */
function annualFigures(rows, annual, pct, finalPct = null) {
  const sum = (box) => round2(rows.filter((r) => r.annual_box === box).reduce((s, r) => s + r.base, 0));
  const figures = { '83': sum('83'), '84': sum('84'), '93': sum('93'), '94': sum('94'), '125': sum('125') };
  figures['80'] = round2(['150', '01', '04', '07', '14'].reduce((s, k) => s + annual[k], 0));
  figures['88'] = round2(figures['80'] + figures['83'] + figures['84'] + figures['93'] + figures['94'] + figures['125']);
  const withRight = figures['88'] - figures['83'];
  let prorrata = null;
  if (figures['88'] > 0 && figures['83'] > 0) {
    const definitive = Math.min(100, Math.ceil((withRight / figures['88']) * 100));
    // the VAT paid before the provisional prorrata, applied again with the final one
    const paid = rows.filter((r) => r.side === 'received' && r.vat_box).reduce((s, r) => s + (r.self_vat !== undefined ? r.self_vat : r.vat), 0);
    prorrata = {
      provisional: pct,
      definitive,
      regularisation: round2((paid * (definitive - pct)) / 100),
      with_right: round2(withRight),
      total: figures['88'],
    };
  }
  if (!prorrata && finalPct !== null) {
    prorrata = { provisional: pct, definitive: null, regularisation: null, with_right: round2(withRight), total: figures['88'] };
  }
  if (prorrata) prorrata.final = finalPct;
  return { figures, prorrata };
}

// the year's final prorrata (Configuració › Anys, set at IVA › Models 303 i 390), or null
function finalDeductiblePct(years, year) {
  const y = (years || []).find((x) => Number(x.year) === Number(year));
  const v = y ? y.final_deductible_vat_pct : null;
  return v === null || v === undefined || v === '' ? null : Number(v);
}

// what a return leaves to compensate: its pending (87) and a negative result
function carryOf(boxes) {
  return round2((Number(boxes['87']) || 0) + Math.max(-(Number(boxes['71']) || 0), 0));
}

// I: to pay, N: nothing, C: to compensate (the last quarter may ask for D: refund)
function defaultDeclarationType(result) {
  if (result > 0) return 'I';
  if (result < 0) return 'C';
  return 'N';
}

/** What a document adds to the return, as kept with a filed return. */
function documentSnapshot(rows) {
  const docs = {};
  for (const r of rows) {
    if (!r.vat_box && !r.info_box && !r.accrued_boxes && !r.issue) continue;
    docs[r.key] = {
      kind: r.kind,
      id: r.id,
      code: r.code,
      contact: r.contact,
      base: r.base,
      vat: r.side === 'received' ? r.deductible_vat : r.vat,
      boxes: [r.accrued_boxes && r.accrued_boxes.join('/'), r.vat_box && (r.base_box ? `${r.base_box}/${r.vat_box}` : r.vat_box), r.info_box].filter(Boolean).join(' · '),
    };
  }
  return docs;
}

const publicReturn = (r) => ({
  id: r.id,
  model: r.model,
  year: r.year,
  period: r.period,
  declaration_type: r.declaration_type,
  filed_date: r.filed_date,
  receipt: r.receipt,
  result: r.result === null || r.result === undefined ? null : Number(r.result),
  notes: r.notes,
  boxes: r.boxes,
});

/**
 * What changed since a return was filed: the boxes that differ and the
 * documents added, removed or changed (another amount or box).
 */
function changesSince(filed, boxes, rows, withDocuments = true) {
  const before = filed.boxes || {};
  const differentBoxes = Object.keys(boxes)
    .filter((k) => typeof boxes[k] === 'number' && round2(Number(before[k]) || 0) !== round2(boxes[k]))
    .map((k) => ({ box: k, filed: round2(Number(before[k]) || 0), now: boxes[k] }));
  const documents = [];
  if (withDocuments) {
    const was = filed.documents || {};
    const now = documentSnapshot(rows);
    for (const [key, d] of Object.entries(now)) {
      const old = was[key];
      if (!old) documents.push({ ...d, key, change: 'added' });
      else if (round2(old.base) !== round2(d.base) || round2(old.vat) !== round2(d.vat) || old.boxes !== d.boxes) documents.push({ ...d, key, change: 'changed', filed: old });
    }
    for (const [key, d] of Object.entries(was)) if (!now[key]) documents.push({ ...d, key, change: 'removed' });
  }
  return differentBoxes.length || documents.length ? { boxes: differentBoxes, documents } : null;
}

/**
 * The 390 is built from the documents as they are now; it has to add up the
 * 303s that were filed. When a quarter's documents changed after filing it
 * (an invoice entered late, an amount corrected), the 390 no longer matches:
 * say which quarters and boxes, and the result the 303s filed (sum of 46)
 * against the 390's (84). Null when no quarter is marked as filed.
 */
function checkAgainstFiled(quarters, model390) {
  const filed = quarters.filter((q) => q.filed && q.filed.boxes);
  if (!filed.length) return null;
  const changed = filed
    .filter((q) => q.changes && q.changes.boxes.length)
    .map((q) => ({ quarter: q.quarter, period: q.period, boxes: q.changes.boxes }));
  const unfiled = quarters.filter((q) => !q.filed).map((q) => q.period);
  const filedResult = filed.length === quarters.length
    ? round2(filed.reduce((s, q) => s + (Number(q.filed.boxes['46']) || 0), 0))
    : null;
  const result = model390.boxes['84'];
  if (!changed.length && !unfiled.length && filedResult === result) return { ok: true, changed: [], unfiled: [], filed_result: filedResult, result };
  return { ok: false, changed, unfiled, filed_result: filedResult, result };
}

// --- 390 -------------------------------------------------------------------

// issued: rate → [base, quota] (page 2, régimen ordinario)
const B390_ISSUED = { 4: ['01', '02'], 10: ['03', '04'], 21: ['05', '06'] };
// self-assessed intra-EU acquisitions, by rate
const B390_INTRA_GOODS = { 4: ['21', '22'], 10: ['23', '24'], 21: ['25', '26'] };
const B390_INTRA_SERVICES = { 4: ['545', '546'], 10: ['547', '548'], 21: ['551', '552'] };
// deductible, by rate (2, 4, 5, 7.5, 10, 21) and the group total
const B390_DEDUCTIBLE = {
  interior: { 2: ['695', '696'], 4: ['190', '191'], 5: ['724', '725'], 7.5: ['697', '698'], 10: ['603', '604'], 21: ['605', '606'], total: ['48', '49'] },
  interiorCapital: { 2: ['749', '750'], 4: ['196', '197'], 5: ['728', '729'], 7.5: ['751', '752'], 10: ['611', '612'], 21: ['613', '614'], total: ['50', '51'] },
  intraGoods: { 2: ['765', '766'], 4: ['214', '215'], 5: ['736', '737'], 7.5: ['767', '768'], 10: ['627', '628'], 21: ['629', '630'], total: ['56', '57'] },
  intraCapital: { 2: ['769', '770'], 4: ['220', '221'], 5: ['738', '739'], 7.5: ['771', '772'], 10: ['631', '632'], 21: ['633', '634'], total: ['58', '59'] },
  intraServices: { 2: ['773', '774'], 4: ['587', '588'], 5: ['740', '741'], 7.5: ['775', '776'], 10: ['635', '636'], 21: ['637', '638'], total: ['597', '598'] },
};

/**
 * The 390's boxes (its own numbering) from the year's rows: VAT charged and
 * deductible by rate, the result, the quarters' results and the volume of
 * operations. `unmapped`: rows at a rate the 390 has no box for.
 */
function boxes390({ rows, annual, quarters, startCarry, pct, finalPct, prorrata, regularisation }) {
  const b = {};
  const add = (box, v) => { b[box] = round2((b[box] || 0) + v); };
  const unmapped = [];
  for (const r of rows) {
    if (r.side === 'issued' && r.base_box) {
      if (r.base_box === '14') { add('29', r.base); add('30', r.vat); continue; }
      const pair = B390_ISSUED[r.rate];
      if (pair) { add(pair[0], r.base); add(pair[1], r.vat); } else unmapped.push(r);
      continue;
    }
    if (r.side !== 'received' || !r.vat_box) continue;
    // 5. agrarian compensations and rectified deductions
    if (r.reagp) { add('60', r.base); add('61', r.deductible_vat); continue; }
    if (r.base_box === '40') { add('639', r.base); add('62', r.deductible_vat); continue; }
    const rate = r.self_rate !== undefined ? r.self_rate : r.rate;
    if (r.accrued_boxes) {
      if (r.reverse_charge === 'isp') { add('27', r.base); add('28', r.self_vat); }
      else {
        const pair = (r.reverse_charge === 'intracom_goods' ? B390_INTRA_GOODS : B390_INTRA_SERVICES)[rate];
        if (pair) { add(pair[0], r.base); add(pair[1], r.self_vat); } else unmapped.push(r);
      }
    }
    let group = 'interior';
    if (r.base_box === '30') group = 'interiorCapital';
    else if (r.base_box === '38') group = 'intraCapital';
    else if (r.base_box === '36') group = r.reverse_charge === 'intracom_goods' ? 'intraGoods' : 'intraServices';
    const pair = B390_DEDUCTIBLE[group][rate];
    if (pair) { add(pair[0], r.base); add(pair[1], r.deductible_vat); } else unmapped.push(r);
    add(B390_DEDUCTIBLE[group].total[0], r.base);
    add(B390_DEDUCTIBLE[group].total[1], r.deductible_vat);
  }
  const sum = (keys) => round2(keys.reduce((s, k) => s + (b[k] || 0), 0));
  b['33'] = sum(['01', '03', '05', '21', '23', '25', '545', '547', '551', '27', '29']);
  b['34'] = sum(['02', '04', '06', '22', '24', '26', '546', '548', '552', '28', '30']);
  b['522'] = regularisation || 0;
  b['64'] = sum(['49', '51', '53', '55', '57', '59', '598', '61', '62', '63', '522']);
  b['65'] = round2(b['34'] - b['64']);
  // 7. the year's result; 8. all of it in territorio común
  b['84'] = b['65'];
  b['85'] = round2(startCarry || 0);
  b['86'] = round2(b['84'] - b['85']);
  b['87'] = 100;
  b['92'] = b['84'];
  b['93'] = b['85'];
  b['94'] = b['86'];
  // 9. the quarters' returns (filed ones as filed)
  const results = quarters.map((q) => (q.filed && q.filed.boxes ? Number(q.filed.boxes['71']) || 0 : q.boxes['71']));
  b['95'] = round2(results.filter((v) => v > 0).reduce((s, v) => s + v, 0));
  const last = quarters[3];
  const lastResult = results[3];
  const lastType = last.filed ? last.filed.declaration_type : last.declaration_type;
  b['97'] = lastResult < 0 && lastType !== 'D' ? round2(-lastResult) : 0;
  b['98'] = lastResult < 0 && lastType === 'D' ? round2(-lastResult) : 0;
  // 10. volume of operations (the 303's 80, 93, 94, 83, 84, 125, 88)
  Object.assign(b, { '99': annual['80'], '103': annual['93'], '104': annual['94'], '105': annual['83'], '110': annual['84'], '125': annual['125'], '108': annual['88'] });
  // 11. exempt or not subject domestic purchases: the 0 % ones from Spain, not
  // purchases from abroad nor foreign VAT (also out of the return)
  // («fora de l'IVA» lines, e.g. the self-employed quota, are no purchase at all)
  b['230'] = round2(rows.filter((r) => r.side === 'received' && r.annual_box === '230').reduce((s, r) => s + r.base, 0));
  // 12. prorrata, when it applies
  const applies = pct < 100 || (finalPct !== null && finalPct < 100) || (prorrata && prorrata.definitive !== null && prorrata.definitive < 100);
  if (applies && prorrata) {
    b['115'] = prorrata.total;
    b['116'] = prorrata.with_right;
    b['117'] = 'G';
    b['118'] = finalPct !== null ? finalPct : prorrata.definitive !== null ? prorrata.definitive : pct;
  }
  return { boxes: b, unmapped: unmapped.length, unmapped_base: round2(unmapped.reduce((s, r) => s + r.base, 0)) };
}

/**
 * @param {object} data { emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses, years, history, returns }
 *   returns: the vat-return rows of the year (and the year before's 4T)
 * @param {number} year
 */
function vatModels(data, year) {
  year = Number(year);
  const rows = documentRows(data, data.years).filter((r) => r.year === year);
  const pct = deductiblePct(data.years, year);

  const finalPct = finalDeductiblePct(data.years, year);
  // box 44 in the last quarter: the year's VAT paid again with the final prorrata
  const paidVat = round2(rows.filter((r) => r.side === 'received' && r.vat_box).reduce((s, r) => s + (r.self_vat !== undefined ? r.self_vat : r.vat), 0));
  const regularisation = finalPct === null ? 0 : round2((paidVat * (finalPct - pct)) / 100);

  const returns = data.returns || [];
  const filed303 = (y, period) => returns.find((r) => r.model === '303' && Number(r.year) === y && r.period === period) || null;
  // compensation pending from the year before: its last quarter, filed asking to compensate
  const previous = filed303(year - 1, '4T');
  const startCarry = previous && previous.declaration_type === 'C' && previous.boxes ? carryOf(previous.boxes) : 0;

  let carry = startCarry;
  const quarters = [1, 2, 3, 4].map((quarter) => {
    const qRows = rows.filter((r) => r.quarter === quarter);
    const boxes = periodBoxes(qRows, carry, quarter === 4 && regularisation ? { '44': regularisation } : {});
    const filed = filed303(year, `${quarter}T`);
    // a filed return carries what was filed, not what the documents say now
    const effective = filed && filed.boxes ? filed.boxes : boxes;
    carry = quarter < 4 ? carryOf(effective) : 0;
    return {
      quarter,
      period: `${quarter}T`,
      deadline: vatPaymentDate(year, quarter).format('YYYY-MM-DD'),
      documents: new Set(qRows.map((r) => `${r.kind}:${r.id}`)).size,
      boxes,
      declaration_type: defaultDeclarationType(boxes['71'], quarter),
      filed: filed ? publicReturn(filed) : null,
      changes: filed ? changesSince(filed, boxes, qRows) : null,
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
  const { figures, prorrata } = annualFigures(rows, annual, pct, finalPct);
  Object.assign(annual, figures);
  const model390 = boxes390({ rows, annual, quarters, startCarry, pct, finalPct, prorrata, regularisation, returns, year });
  const filed390 = returns.find((r) => r.model === '390' && Number(r.year) === year) || null;
  const check390 = checkAgainstFiled(quarters, model390);

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
  if (pct < 100 || finalPct !== null) {
    notes.push({
      code: 'prorrata',
      text: finalPct === null
        ? `L'IVA suportat es dedueix al ${pct} % (prorrata provisional de l'any, Configuració › Anys). Quan es fixi la prorrata definitiva al T4, la regularització va a la casella 44.`
        : `L'IVA suportat es dedueix al ${pct} % (prorrata provisional) i la definitiva és del ${finalPct} %: la regularització, ${regularisation} €, va a la casella 44 del T4.`,
    });
  }
  notes.push({
    code: 'compensation',
    text: previous
      ? "Les quotes a compensar (110) surten de les declaracions marcades com a presentades: les del T1 vénen del 4T de l'any anterior si s'hi va demanar compensar."
      : "Les quotes a compensar (110) surten de les declaracions marcades com a presentades i dels resultats negatius d'aquest any. El 4T de l'any anterior no està marcat com a presentat: si s'hi va demanar compensar, marca'l perquè el T1 ho tingui en compte.",
  });
  notes.push({
    code: 'unsupported',
    text: "No es contemplen el criteri de caixa, el recàrrec d'equivalència, el règim simplificat, la finestreta única (OSS), les importacions, els sectors diferenciats ni la regularització de béns d'inversió (43).",
  });

  return {
    year,
    deductible_pct: pct,
    final_deductible_pct: finalPct,
    quarters,
    annual,
    model390,
    filed390: filed390 ? publicReturn(filed390) : null,
    changes390: filed390 ? changesSince(filed390, model390.boxes, rows, false) : null,
    check390,
    prorrata,
    issues,
    notes,
    rows,
  };
}

module.exports = { vatModels, contactArea, documentRows, documentSnapshot, periodBoxes, deductiblePct, OPERATIONS, REVERSE_CHARGES, VAT_SPECIALS };
