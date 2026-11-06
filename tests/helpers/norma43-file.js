'use strict';

/**
 * Builds Norma 43 files for the tests (issues/413): records of 80 characters
 * as the banks write them.
 *
 * norma43File([{ bank, branch, account, start, end, opening, movements: [
 *   { date, value?, amount, concept?, document?, ref1?, ref2? } ] }])
 * Dates are YYYY-MM-DD; amounts are signed euros.
 */

const yymmdd = (d) => d.substring(2, 4) + d.substring(5, 7) + d.substring(8, 10);
const money = (v) => String(Math.round(Math.abs(v) * 100)).padStart(14, '0');
const sign = (v) => (v < 0 ? '1' : '2');
const field = (s, n) => String(s || '').padEnd(n, ' ').substring(0, n);

function norma43File(accounts, { footer = true } = {}) {
  const lines = [];
  for (const a of accounts) {
    lines.push(
      `11${a.bank}${a.branch}${a.account}${yymmdd(a.start)}${yymmdd(a.end)}${sign(a.opening)}${money(a.opening)}9783${field(a.name || 'COOPERATIVA', 26)}   `,
    );
    let balance = a.opening;
    for (const m of a.movements) {
      balance = Math.round((balance + m.amount) * 100) / 100;
      lines.push(
        `22    ${a.branch}${yymmdd(m.date)}${yymmdd(m.value || m.date)}02000${sign(m.amount)}${money(m.amount)}${field(m.document, 10)}${field(m.ref1, 12)}${field(m.ref2, 16)}`,
      );
      if (m.concept) lines.push(`2301${field(m.concept, 38)}${field(m.concept2, 38)}`);
    }
    const out = a.movements.filter((m) => m.amount < 0);
    const inn = a.movements.filter((m) => m.amount > 0);
    const total = (list) => list.reduce((s, m) => s + Math.abs(m.amount), 0);
    const closing = a.closing !== undefined ? a.closing : balance;
    if (footer) {
      lines.push(
        `33${a.bank}${a.branch}${a.account}${String(out.length).padStart(5, '0')}${money(total(out))}${String(inn.length).padStart(5, '0')}${money(total(inn))}${sign(closing)}${money(closing)}978    `,
      );
    }
  }
  lines.push(`88${'9'.repeat(18)}${String(lines.length).padStart(6, '0')}${' '.repeat(54)}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { norma43File };
