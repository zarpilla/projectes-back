'use strict';

const { round2 } = require('./balances');

/**
 * Grouped payroll lines in Tresoreria (issues/347): it showed one line per
 * person. Lines of the same part, type, bank account, date and paid state
 * become one; the people go in the contact and the amount is their sum. A
 * group of one keeps the payroll's own line.
 *
 * - The net payment (the bestreta) is grouped per payroll month too: one line
 *   per month and bank account, linked to that month's Bestretes.
 * - IRPF, SS and «Altres» are paid once for several months (IRPF once a
 *   quarter), so they are grouped by payment date only: one line per payment,
 *   whatever the months it covers.
 *
 * Each row carries `payroll_month` ("2026-03") and `payroll_part` (net,
 * irpf, ss, other) while it is built; they are dropped from the answer.
 */
const CONCEPT_PREFIX = { net: 'Nòmines', irpf: 'IRPF nòmines', ss: 'SS nòmines', other: 'Altres nòmines' };

const MONTH = /^\d{4}-\d{2}$/;

// by payment for IRPF, SS and other; a payroll without a month stays alone
const groupsByMonth = (row) => row.payroll_part === 'net' || !MONTH.test(row.payroll_month);

const groupKey = (row) => [
  row.payroll_part,
  row.type,
  groupsByMonth(row) ? row.payroll_month : '',
  row.bank_account || '',
  row.date && row.date.isValid && row.date.isValid() ? row.date.format('YYYY-MM-DD') : '',
  row.paid ? 1 : 0,
].join('|');

const bestretesLink = (payrollMonth) => {
  const [year, month] = String(payrollMonth || '').split('-');
  return year && month ? `/bestretes?any=${year}&mes=${Number(month)}` : null;
};

// «IRPF 2026 T3» page for the IRPF lines (issues/348)
const irpfLink = (payrollMonth) => {
  const [year, month] = String(payrollMonth || '').split('-');
  return year && month ? `/irpf?any=${year}&trimestre=${Math.ceil(Number(month) / 3)}` : null;
};

const unique = (list) => [...new Set(list)];

function groupedConcept(prefix, months, count) {
  if (months.length === 1) return `${prefix} ${months[0]} (${count} persones)`;
  return `${prefix} ${months[0]} a ${months[months.length - 1]} (${count} nòmines)`;
}

function groupedLink(part, months) {
  if (part === 'irpf') return irpfLink(months[months.length - 1]);
  return months.length === 1 ? bestretesLink(months[0]) : null;
}

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
    const months = unique(members.map((m) => m.payroll_month)).sort();
    const names = unique(members.map((m) => m.contact).filter(Boolean));
    const keys = members.map((m) => m.validation_key).filter(Boolean);
    const prefix = CONCEPT_PREFIX[first.payroll_part] || 'Nòmines';
    out.push({
      project_name: '',
      project_id: 0,
      type: first.type,
      concept: groupedConcept(prefix, months, members.length),
      total_amount: round2(members.reduce((sum, m) => sum + (m.total_amount || 0), 0)),
      date: first.date,
      date_error: members.some((m) => m.date_error),
      paid: first.paid,
      contact: names.join(', '),
      to: groupedLink(first.payroll_part, months),
      bank_account: first.bank_account,
      payroll_count: members.length,
      validation_key: keys[0] || null,
      validation_keys: keys,
      is_validated: members.every((m) => m.is_validated),
    });
  }
  return out;
}

module.exports = { groupPayrollRows, bestretesLink, irpfLink };
