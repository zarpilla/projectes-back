'use strict';

/**
 * «Conciliació» (issues/413): which Tresoreria lines a bank movement can be.
 * Pure functions over the movement and the lines of the treasury forecast;
 * services/reconcile.js reads and writes the database.
 *
 * A line is a candidate when it isn't validated yet and it either
 *   - is pending on a document (`settle`, issues/415): accepting it marks the
 *     document collected or paid on the bank's date, or
 *   - has already been paid or collected (a document, a partial payment, a
 *     payroll group, IRPF, SS, an «Operació de tresoreria»): accepting it
 *     validates it.
 * Project forecasts, VAT forecasts and unpaid payrolls have nothing to mark
 * and are left out.
 *
 * Scoring: the exact amount is required (except for a partial payment of a
 * document identified in the concept); then the same bank account, the
 * document number, the contact's NIF or name in the concept, and the date.
 * A movement is accepted on its own only when it has exactly one candidate of
 * that amount, on its account, close in date or identified in the concept,
 * and no other movement of the run wants the same line.
 */

const moment = require('moment');

const CENT = 0.005;
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// days the bank date may fall from the line's date: an executed line has
// its real date; a pending one is often collected late
const WINDOW = { executed: [-10, 10], pending: [-30, 120] };
const SUM_WINDOW = 10;
const SUM_MAX_LINES = 4;
const SUM_POOL = 20;

const STOP_WORDS = new Set([
  'SL', 'SLU', 'SA', 'SAU', 'SCCL', 'SCOOP', 'COOP', 'COOPERATIVA', 'ASSOCIACIO', 'ASSOCIACION', 'FUNDACIO',
  'FUNDACION', 'AJUNTAMENT', 'AYUNTAMIENTO', 'DE', 'DEL', 'LA', 'LES', 'LOS', 'LAS', 'EL', 'I', 'Y', 'AND',
]);

/** Upper case, no accents, only letters, digits and single spaces. */
const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const compact = (s) => normalize(s).replace(/ /g, '');

const days = (a, b) => moment(a, 'YYYY-MM-DD').diff(moment(b, 'YYYY-MM-DD'), 'days');

/** The text of a bank movement where references are looked for. */
const movementText = (m) => normalize([m.concept, m.reference, m.document].filter(Boolean).join(' '));

/**
 * The candidates among the rows of GET /treasuries/forecast.
 * @returns {object[]} { id, keys | settle, amount, date, account, contact, nif, code, type, to, pending }
 */
function candidatesFromForecast(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.is_validated || r.is_real_balance_adjustment || r.is_balance_annotation) continue;
    const base = {
      amount: round2(r.total_amount),
      date: r.datef
        ? `${r.datef.substring(0, 4)}-${r.datef.substring(4, 6)}-${r.datef.substring(6, 8)}`
        : moment(r.date).format('YYYY-MM-DD'),
      account: r.bank_account || null,
      contact: r.contact && r.contact !== '-' && r.contact !== '?' ? r.contact : '',
      nif: r.contact_nif || '',
      code: r.concept || '',
      type: r.type,
      to: r.to || null,
    };
    if (!base.amount) continue;
    if (r.settle) {
      out.push({ ...base, id: `settle:${r.settle.kind}:${r.settle.id}`, settle: r.settle, pending: true });
    } else if (r.paid === true) {
      const keys = r.validation_keys && r.validation_keys.length ? r.validation_keys : r.validation_key ? [r.validation_key] : [];
      if (keys.length) out.push({ ...base, id: `keys:${keys.join('|')}`, keys, pending: false });
    }
  }
  return out;
}

const inWindow = (diff, pending) => {
  const [from, to] = pending ? WINDOW.pending : WINDOW.executed;
  return diff >= from && diff <= to;
};

/** What identifies the line in the movement's text. */
function identification(text, line) {
  const found = {};
  const flat = text.replace(/ /g, '');
  const code = compact(line.code);
  if (code.length >= 4 && flat.includes(code)) found.code = true;
  const nif = compact(line.nif);
  if (nif.length >= 8 && flat.includes(nif)) found.nif = true;
  const words = normalize(line.contact)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  if (words.length) {
    const tokens = new Set(text.split(' '));
    const hits = words.filter((w) => tokens.has(w)).length;
    if (hits >= Math.min(2, words.length)) found.name = true;
  }
  return found;
}

function score(m, line, text) {
  const diff = days(m.date, line.date);
  const id = identification(text, line);
  let s = 50;
  s += line.account && m.account && line.account === m.account ? 15 : -20;
  if (id.code) s += 25;
  if (id.nif) s += 20;
  if (id.name) s += 15;
  s += Math.max(0, 10 - Math.abs(diff));
  return { score: s, diff, id };
}

const identified = (id) => Boolean(id.code || id.nif || id.name);

/**
 * Suggestions for one movement, best first.
 * @param {object} m { id, amount, date, account (name), concept, reference, document }
 * @param {object[]} lines candidatesFromForecast(...)
 * @returns {object[]} { kind: 'line'|'partial'|'lines', lines, amount, score, auto }
 */
function suggest(m, lines, { limit = 5 } = {}) {
  const amount = round2(m.amount);
  const text = movementText(m);
  const out = [];
  const exact = [];

  for (const line of lines) {
    if (Math.sign(line.amount) !== Math.sign(amount)) continue;
    const r = score(m, line, text);
    if (!inWindow(r.diff, line.pending)) continue;
    if (Math.abs(line.amount - amount) < CENT) {
      exact.push({ line, ...r });
    } else if (line.pending && line.settle && Math.abs(amount) < Math.abs(line.amount) && identified(r.id)) {
      out.push({ kind: 'partial', lines: [line], amount, score: r.score - 30, auto: false });
    }
  }

  for (const e of exact) {
    const sameAccount = e.line.account && e.line.account === m.account;
    const auto = exact.length === 1 && sameAccount && (Math.abs(e.diff) <= 3 || identified(e.id));
    out.push({ kind: 'line', lines: [e.line], amount, score: e.score, auto });
  }

  if (!exact.length) {
    for (const combo of sums(m, lines, amount)) {
      // lines the concept names (their contact, code or NIF) come before a
      // partial payment of another document of that contact
      const named = combo.every((l) => identified(identification(text, l)));
      out.push({ kind: 'lines', lines: combo, amount, score: 40 - combo.length + (named ? 30 : 0), auto: false });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// a few lines of the same account and sign, close in date, that add up to the
// movement: a remittance, several invoices paid at once
function sums(m, lines, amount) {
  const pool = lines
    .filter(
      (l) =>
        Math.sign(l.amount) === Math.sign(amount) &&
        Math.abs(l.amount) < Math.abs(amount) &&
        l.account === m.account &&
        Math.abs(days(m.date, l.date)) <= (l.pending ? WINDOW.pending[1] : SUM_WINDOW),
    )
    .sort((a, b) => Math.abs(days(m.date, a.date)) - Math.abs(days(m.date, b.date)))
    .slice(0, SUM_POOL);
  const found = [];
  const target = Math.round(amount * 100);
  const cents = pool.map((l) => Math.round(l.amount * 100));
  const walk = (start, chosen, total) => {
    if (found.length >= 3) return;
    if (chosen.length >= 2 && total === target) {
      found.push(chosen.map((i) => pool[i]));
      return;
    }
    if (chosen.length >= SUM_MAX_LINES) return;
    for (let i = start; i < pool.length; i++) {
      const next = total + cents[i];
      if (Math.abs(next) > Math.abs(target)) continue;
      walk(i + 1, [...chosen, i], next);
    }
  };
  walk(0, [], 0);
  return found;
}

/**
 * The movements accepted on their own in a run: each with its one automatic
 * suggestion, unless another movement of the run wants the same line.
 * @returns {Map<movementId, suggestion>}
 */
function autoMatches(movements, lines) {
  const wanted = new Map();
  for (const m of movements) {
    const best = suggest(m, lines, { limit: 1 })[0];
    if (best && best.auto) wanted.set(m.id, best);
  }
  const uses = new Map();
  for (const s of wanted.values()) {
    const id = s.lines[0].id;
    uses.set(id, (uses.get(id) || 0) + 1);
  }
  for (const [mid, s] of wanted) {
    if (uses.get(s.lines[0].id) > 1) wanted.delete(mid);
  }
  return wanted;
}

/**
 * Two movements of the tenant's own accounts that are one transfer: opposite
 * amounts, different accounts, at most 3 days apart.
 */
function transferPairs(movements) {
  const pairs = [];
  const used = new Set();
  for (const a of movements) {
    if (used.has(a.id) || !(a.amount < 0)) continue;
    const b = movements.find(
      (x) =>
        !used.has(x.id) &&
        x.id !== a.id &&
        x.account !== a.account &&
        Math.abs(round2(x.amount) + round2(a.amount)) < CENT &&
        Math.abs(days(x.date, a.date)) <= 3,
    );
    if (b) {
      used.add(a.id);
      used.add(b.id);
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/** The first active rule whose text is in the movement's concept. */
function ruleFor(m, rules) {
  const text = movementText(m);
  return (
    (rules || []).find((r) => {
      if (r.active === false) return false;
      const pattern = normalize(r.pattern);
      if (!pattern || !text.includes(pattern)) return false;
      if (r.direction === 'in' && !(m.amount > 0)) return false;
      if (r.direction === 'out' && !(m.amount < 0)) return false;
      if (r.bank_account && r.bank_account.name && r.bank_account.name !== m.account) return false;
      return true;
    }) || null
  );
}

module.exports = {
  candidatesFromForecast,
  suggest,
  autoMatches,
  transferPairs,
  ruleFor,
  normalize,
  movementText,
  round2,
};
