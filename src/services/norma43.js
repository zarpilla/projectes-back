'use strict';

/**
 * Bank statements in Norma 43 (AEB / CSB «Cuaderno 43»), the file every
 * Spanish bank lets you download from online banking (issues/413).
 *
 * Fixed-width records of 80 characters, one per line:
 *   11  account header: bank (4), branch (4), account (10), start and end
 *       dates (YYMMDD), opening balance with its sign, currency, name
 *   22  movement: operation and value dates, common and own concept codes,
 *       debit (1) / credit (2), amount, document number, two references
 *   23  extra concept lines of the movement before (up to 5, 2 × 38 chars)
 *   24  currency equivalence (ignored)
 *   33  account footer: debit and credit counts and totals, closing balance
 *   88  end of file: number of records
 * Amounts have 14 digits, the last 2 the cents. Debit = money out (negative).
 *
 * The account has no IBAN, only the CCC without its check digits: bank,
 * branch and account (see `matchesIban`).
 */

class Norma43Error extends Error {}

const amount = (digits, sign) => {
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) throw new Norma43Error(`Import no vàlid: «${digits}»`);
  return ((sign === '1' ? -1 : 1) * n) / 100;
};

const date = (yymmdd) => {
  if (!/^\d{6}$/.test(yymmdd)) throw new Norma43Error(`Data no vàlida: «${yymmdd}»`);
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  // statements are recent: 00–79 → 2000s
  const year = yy < 80 ? 2000 + yy : 1900 + yy;
  return `${year}-${yymmdd.substring(2, 4)}-${yymmdd.substring(4, 6)}`;
};

const text = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * @param {string} content the file, already decoded (banks use Latin-1)
 * @returns {{ accounts: object[] }} one entry per 11…33 block:
 *   { bank, branch, account, ccc, name, currency, start, end, opening, closing,
 *     movements: [{ date, value_date, amount, common_concept, own_concept,
 *                   document, reference1, reference2, concept, line }] }
 */
function parseNorma43(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Norma43Error('El fitxer és buit');
  const lines = content.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const accounts = [];
  let account = null;
  let last = null;
  let ended = false;

  lines.forEach((raw, i) => {
    const n = i + 1;
    if (!raw.trim()) return;
    if (ended) throw new Norma43Error(`Línia ${n}: hi ha registres després del final del fitxer (88)`);
    const line = raw.padEnd(80, ' ');
    const code = line.substring(0, 2);
    if (code === '11') {
      if (account) throw new Norma43Error(`Línia ${n}: falta el tancament (33) del compte anterior`);
      account = {
        bank: line.substring(2, 6),
        branch: line.substring(6, 10),
        account: line.substring(10, 20),
        start: date(line.substring(20, 26)),
        end: date(line.substring(26, 32)),
        opening: amount(line.substring(33, 47), line.substring(32, 33)),
        currency: line.substring(47, 50),
        name: text(line.substring(51, 77)),
        movements: [],
      };
      account.ccc = `${account.bank}${account.branch}${account.account}`;
      last = null;
    } else if (code === '22') {
      if (!account) throw new Norma43Error(`Línia ${n}: moviment fora d'un compte`);
      last = {
        date: date(line.substring(10, 16)),
        value_date: date(line.substring(16, 22)),
        common_concept: line.substring(22, 24),
        own_concept: line.substring(24, 27),
        amount: amount(line.substring(28, 42), line.substring(27, 28)),
        document: line.substring(42, 52).trim(),
        reference1: line.substring(52, 64).trim(),
        reference2: line.substring(64, 80).trim(),
        concepts: [],
        line: n,
      };
      account.movements.push(last);
    } else if (code === '23') {
      if (!last) throw new Norma43Error(`Línia ${n}: concepte sense moviment`);
      last.concepts.push(line.substring(4, 42), line.substring(42, 80));
    } else if (code === '24') {
      // currency equivalence: the amount in euros is already in the 22
    } else if (code === '33') {
      if (!account) throw new Norma43Error(`Línia ${n}: tancament sense compte`);
      const footer = {
        debits: parseInt(line.substring(20, 25), 10),
        debitTotal: amount(line.substring(25, 39), '2'),
        credits: parseInt(line.substring(39, 44), 10),
        creditTotal: amount(line.substring(44, 58), '2'),
      };
      account.closing = amount(line.substring(59, 73), line.substring(58, 59));
      const out = account.movements.filter((m) => m.amount < 0);
      const inn = account.movements.filter((m) => m.amount > 0);
      const sum = (list) => Math.round(list.reduce((s, m) => s + Math.abs(m.amount), 0) * 100) / 100;
      if (out.length !== footer.debits || inn.length !== footer.credits || sum(out) !== footer.debitTotal || sum(inn) !== footer.creditTotal) {
        throw new Norma43Error(
          `Línia ${n}: el tancament del compte ${account.ccc} no quadra amb els moviments (fitxer incomplet o malmès)`,
        );
      }
      account.movements.forEach((m) => {
        m.concept = text([...m.concepts].join(' '));
        delete m.concepts;
      });
      accounts.push(account);
      account = null;
      last = null;
    } else if (code === '88') {
      ended = true;
    } else {
      throw new Norma43Error(`Línia ${n}: registre desconegut «${code}». És un fitxer Norma 43?`);
    }
  });
  if (account) throw new Norma43Error(`Falta el tancament (33) del compte ${account.ccc}`);
  if (!accounts.length) throw new Norma43Error('El fitxer no té cap compte. És un fitxer Norma 43?');
  return { accounts };
}

/**
 * Whether a stored IBAN is the statement's account: a Spanish IBAN is
 * ES + 2 check digits + bank (4) + branch (4) + 2 check digits + account (10).
 */
function matchesIban(iban, acc) {
  const s = String(iban || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^ES\d{22}$/.test(s)) return false;
  return s.substring(4, 8) === acc.bank && s.substring(8, 12) === acc.branch && s.substring(14, 24) === acc.account;
}

module.exports = { parseNorma43, matchesIban, Norma43Error };
