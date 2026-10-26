'use strict';

const { round2 } = require('./balances');

/**
 * One Tresoreria line per bank account for the payrolls of a month
 * (issues/347): it showed one line per person. The lines of the same type
 * (net, IRPF, SS, other), payroll month, bank account, date and paid state
 * become one; the people go in the contact and the amount is their sum. A
 * group of one keeps the payroll's own line.
 *
 * Each row carries `payroll_month` ("2026-03") and `payroll_part` (net,
 * irpf, ss, other) while it is built; they are dropped from the answer.
 */
const CONCEPT_PREFIX = { net: 'Nòmines', irpf: 'IRPF nòmines', ss: 'SS nòmines', other: 'Altres nòmines' };

const groupKey = (row) => [
  row.payroll_part,
  row.type,
  row.payroll_month,
  row.bank_account || '',
  row.date && row.date.isValid && row.date.isValid() ? row.date.format('YYYY-MM-DD') : '',
  row.paid ? 1 : 0,
].join('|');

const bestretesLink = (payrollMonth) => {
  const [year, month] = String(payrollMonth || '').split('-');
  return year && month ? `/bestretes?any=${year}&mes=${Number(month)}` : null;
};

function groupPayrollRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      const { payroll_month, payroll_part, ...row } = members[0];
      out.push(row);
      continue;
    }
    const first = members[0];
    const names = members.map((m) => m.contact).filter(Boolean);
    const keys = members.map((m) => m.validation_key).filter(Boolean);
    const prefix = CONCEPT_PREFIX[first.payroll_part] || 'Nòmines';
    out.push({
      project_name: '',
      project_id: 0,
      type: first.type,
      concept: `${prefix} ${first.payroll_month} (${members.length} persones)`,
      total_amount: round2(members.reduce((sum, m) => sum + (m.total_amount || 0), 0)),
      date: first.date,
      date_error: members.some((m) => m.date_error),
      paid: first.paid,
      contact: names.join(', '),
      to: bestretesLink(first.payroll_month),
      bank_account: first.bank_account,
      payroll_count: members.length,
      validation_key: keys[0] || null,
      validation_keys: keys,
      is_validated: members.every((m) => m.is_validated),
    });
  }
  return out;
}

module.exports = { groupPayrollRows, bestretesLink };
