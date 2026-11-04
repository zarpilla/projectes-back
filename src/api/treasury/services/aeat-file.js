'use strict';

const dr303 = require('./aeat/dr303-2026.json');
const dr390 = require('./aeat/dr390-2026.json');

/**
 * IVA › Models 303 i 390 (Beta): the files the AEAT's forms import
 * («Importar» on the Sede's model 303 / 390 form), filled from the specs in
 * ./aeat (extracted from the official register designs by
 * tools/aeat-dr/extract.py; they change each year).
 *
 * Each page is a fixed-width record: constants as the design gives them,
 * numbers right-aligned with zeros and two decimals without a point (`N`
 * fields with an N in front when negative), text left-aligned with blanks, in
 * capitals and with only letters, digits and blanks. `values` maps a box
 * number to its value (an array when the box repeats in the page, one per
 * occurrence) and `fields` a field number to its value, for the fields
 * without a box (identification).
 */

class AeatFileError extends Error {}

const DECIMALS = 2;

// letters (with Ñ, Ç and accents taken off), digits and blanks
function text(value, length) {
  const clean = String(value === null || value === undefined ? '' : value)
    .toUpperCase()
    .replace(/Ñ/g, '\uE000')
    .replace(/Ç/g, '\uE001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\uE000/g, 'Ñ')
    .replace(/\uE001/g, 'Ç')
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, length).padEnd(length, ' ');
}

// 2 decimals without the point, zeros on the left; `signed`: N in front when negative
function number(value, length, signed, decimals = DECIMALS) {
  const n = Number(value) || 0;
  if (n < 0 && !signed) throw new AeatFileError(`Import negatiu en un camp sense signe: ${n}`);
  const digits = String(Math.round(Math.abs(n) * 10 ** decimals));
  const width = n < 0 ? length - 1 : length;
  if (digits.length > width) throw new AeatFileError(`Import massa gran: ${n}`);
  return (n < 0 ? 'N' : '') + digits.padStart(width, '0');
}

const isNumeric = (type) => /^(Num|N)$/.test(String(type).trim());

// the boxes are amounts or percentages with 2 decimals («15 enteros y 2
// decimales», «3 enteros y 2 decimales»); the other numbers (year, flags) are whole
function numericField(field, value) {
  const type = String(field.type).trim();
  try {
    return number(value, field.len, type === 'N', field.box ? DECIMALS : 0);
  } catch (e) {
    throw new AeatFileError(`${e.message} (${field.box ? `casella ${field.box}` : field.desc})`);
  }
}

function renderPage(page, { values = {}, fields = {} } = {}) {
  const seen = {};
  let out = '';
  for (const field of page.fields) {
    let value;
    if (field.constant !== undefined && fields[field.n] === undefined) value = field.constant;
    else if (fields[field.n] !== undefined) value = fields[field.n];
    else if (field.box && values[field.box] !== undefined) {
      const v = values[field.box];
      const i = (seen[field.box] = (seen[field.box] || 0) + 1) - 1;
      value = Array.isArray(v) ? v[i] : v;
    }
    let piece;
    if (field.constant !== undefined && fields[field.n] === undefined) piece = String(field.constant).padEnd(field.len, ' ').slice(0, field.len);
    else if (isNumeric(field.type) && (typeof value === 'number' || value === undefined || value === null)) piece = numericField(field, value);
    else piece = text(value, field.len);
    out += piece;
  }
  if (out.length !== page.length) throw new AeatFileError(`Pàgina ${page.sheet}: ${out.length} posicions, n'esperava ${page.length}`);
  return out;
}

const pageOf = (spec, sheet) => spec.pages.find((p) => p.sheet === sheet);

// the envelope (page 0): <T{model}0{year}{period}0000><AUX>…</AUX>{pages}</T{model}0{year}{period}0000>
function envelope(spec, model, year, period, content, software = {}) {
  const head = pageOf(spec, spec.pages[0].sheet);
  let out = '';
  for (const field of head.fields) {
    if (field.n === 4) out += String(year).padStart(4, '0');
    else if (field.n === 5) out += period;
    else if (field.n === 9) out += text(software.version || '', 4);
    else if (field.n === 11) out += text(software.nif || '', 9);
    else if (field.n === 14) out += content;
    else if (field.n === 15) out += `</T${model}0${year}${period}0000>`;
    else if (field.constant !== undefined) out += String(field.constant);
    else out += ' '.repeat(field.len);
  }
  return out;
}

const PERIODS_303 = ['1T', '2T', '3T', '4T'];
const DECLARATION_TYPES = ['I', 'U', 'C', 'D', 'N', 'G', 'V', 'X'];

/**
 * The model 303 file of a quarter.
 * @param {object} p { year, period ('1T'…'4T'), boxes (the quarter's), declarationType,
 *   me { nif, name, aeat_activity_code, aeat_iae, aeat_cnae, aeat_vat_390_exempt },
 *   annual (the year's 303 boxes: 80…88), prorrata { total, with_right, pct } or null,
 *   iban, software { version, nif } }
 */
function file303({ year, period, boxes, declarationType, me = {}, annual = {}, prorrata = null, iban = '', software = {} }) {
  if (!PERIODS_303.includes(period)) throw new AeatFileError(`Període no vàlid: ${period}`);
  if (!DECLARATION_TYPES.includes(declarationType)) throw new AeatFileError(`Tipus de declaració no vàlid: ${declarationType}`);
  if (!me.nif) throw new AeatFileError("Falta el NIF de l'entitat (Configuració).");
  if ((declarationType === 'U' || declarationType === 'D') && !iban) throw new AeatFileError("Per domiciliar o demanar la devolució cal l'IBAN.");
  const last = period === '4T';
  const exempt390 = last && !!me.aeat_vat_390_exempt;
  const b = boxes;
  const page1 = renderPage(pageOf(dr303, 'DP30301'), {
    values: b,
    fields: {
      5: ' ',
      6: declarationType,
      7: String(me.nif).replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
      8: me.name,
      9: Number(year),
      10: period,
      // see the design's notes 3–9: not foral, not REDEME, only régimen general,
      // not joint, no cash accounting, no special prorrata, no concurso, no SII
      11: 2, 12: 2, 13: 3, 14: 2, 15: 2, 16: 2,
      17: last ? 2 : ' ', 18: last ? 2 : ' ',
      19: 2, 20: '', 21: '', 22: 2,
      23: last ? (exempt390 ? 1 : 2) : 0,
      24: exempt390 ? (Number(annual['88']) ? 1 : 2) : 0,
      25: 0,
    },
  });
  const pages = [page1];
  const page3Values = { ...b, 65: 100 };
  pages.push(renderPage(pageOf(dr303, 'DP30303'), {
    values: page3Values,
    fields: { 30: declarationType === 'N' && !Number(b['71']) ? 'X' : '', 31: '', 32: '', 33: '' , 35: '', 36: '' },
  }));
  if (exempt390) {
    pages.push(renderPage(pageOf(dr303, 'DP30304'), {
      values: { ...annual, 107: 100 },
      fields: { 5: ' ', 6: me.aeat_activity_code || '', 7: me.aeat_iae || '', 18: '' },
    }));
  }
  if (last && prorrata) {
    pages.push(renderPage(pageOf(dr303, 'DP30305'), {
      values: { 501: prorrata.total, 502: prorrata.with_right, 504: prorrata.pct },
      fields: { 5: ' ', 6: me.aeat_cnae || '', 9: 'G', 11: '', 14: '', 16: '', 19: '', 21: '', 24: '', 26: '', 29: '' },
    }));
  }
  if (declarationType === 'U' || declarationType === 'D') {
    const clean = String(iban).replace(/\s/g, '').toUpperCase();
    pages.push(renderPage(pageOf(dr303, 'DP303DID'), {
      fields: { 5: '', 6: clean, 7: '', 8: '', 9: '', 10: '', 11: clean.startsWith('ES') ? 1 : 2 },
    }));
  }
  return envelope(dr303, '303', year, period, pages.join(''), software);
}

/**
 * The model 390 file of a year.
 * @param {object} p { year, boxes (the 390's), me { nif, name, aeat_activity, aeat_activity_code,
 *   aeat_iae, aeat_cnae }, software }
 */
function file390({ year, boxes, me = {}, software = {} }) {
  if (!me.nif) throw new AeatFileError("Falta el NIF de l'entitat (Configuració).");
  const values = { ...boxes };
  // 12. prorrata: the first of the five, when it applies
  const prorrata = values['117'] !== undefined;
  for (const k of ['115', '116', '118']) values[k] = prorrata ? [values[k], 0, 0, 0, 0] : 0;
  values['117'] = [prorrata ? values['117'] : '', '', '', '', ''];
  values['114'] = [prorrata ? me.aeat_cnae || '' : '', '', '', '', ''];
  const pages = [
    renderPage(pageOf(dr390, 'Pág. 1'), {
      fields: {
        5: ' ', 6: ' ',
        7: String(me.nif).replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
        8: me.name,
        9: '',
        10: Number(year),
        11: '',
        // not REDEME, not a group, no cash accounting, no concurso, no fuel
        12: '0', 13: '0', 14: '', 15: '0', 16: '0', 17: '0', 18: '', 19: '2', 20: '2', 21: '2', 22: '2',
        23: 0, 24: 0, 25: '',
        26: me.aeat_activity || '', 27: me.aeat_activity_code || '', 28: me.aeat_iae || '',
      },
    }),
    renderPage(pageOf(dr390, 'Pág. 2'), { values, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 2 bis'), { values: {}, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 3'), { values, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 4'), { values, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 5'), { values: {}, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 6'), { values, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 7'), { values, fields: { 5: ' ' } }),
    renderPage(pageOf(dr390, 'Pág. 8'), { values: {}, fields: { 5: ' ' } }),
  ];
  return envelope(dr390, '390', year, '0A', pages.join(''), software);
}

module.exports = { file303, file390, renderPage, text, number, AeatFileError, dr303, dr390 };
