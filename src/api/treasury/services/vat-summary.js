'use strict';

const moment = require('moment');
const { round2 } = require('./balances');
const { vatPaymentDate } = require('./vat-forecast');

/**
 * IVA › «Saldo i documents» (issues/418), laid out like the IRPF page: the
 * documents with VAT of a year, settled («Salda», vat_paid_date) or not, per
 * quarter and one by one.
 *
 * The same documents and amounts as the VAT Tresoreria and «Salda» use
 * (treasury controller, emitted-invoice payVatIds): issued invoices (not
 * drafts) and received incomes charge VAT; received invoices and received
 * expenses carry supported VAT, deductible at their year's «% IVA deduïble»
 * (an empty year is 100 %, issues/338). A settled document keeps the % it was
 * settled with.
 *
 * `balance` is signed as Tresoreria's: negative = to pay to Hisenda.
 */

const DAY = 'YYYY-MM-DD';

const KINDS = {
  'emitted-invoices': { supported: false },
  'received-incomes': { supported: false },
  'received-invoices': { supported: true },
  'received-expenses': { supported: true },
};

// a year's «% IVA deduïble» (0–100); empty or missing year → 100
function yearDeductiblePct(years, date) {
  const y = (years || []).find((row) => String(row.year) === String(date).slice(0, 4));
  return y && y.deductible_vat_pct !== null && y.deductible_vat_pct !== undefined ? Number(y.deductible_vat_pct) : 100;
}

const dayOf = (value) => {
  if (!value) return null;
  if (value instanceof Date) return moment(value).format(DAY);
  return String(value).slice(0, 10);
};

function vatRow(doc, kind, years) {
  const { supported } = KINDS[kind];
  const m = moment(doc.emitted, DAY);
  const vat = round2(Number(doc.total_vat) || 0);
  const base = doc.total_base !== null && doc.total_base !== undefined
    ? round2(Number(doc.total_base))
    : round2((Number(doc.total) || 0) - vat);
  const settledDate = dayOf(doc.vat_paid_date);
  const storedPct = doc.deductible_vat_pct !== null && doc.deductible_vat_pct !== undefined ? Number(doc.deductible_vat_pct) : null;
  const pct = supported ? (settledDate && storedPct !== null ? storedPct : yearDeductiblePct(years, doc.emitted)) : null;
  const deductible = supported ? round2((vat * pct) / 100) : 0;
  return {
    key: `${kind}:${doc.id}`,
    kind,
    id: doc.id,
    code: doc.code || '',
    contact: doc.contact && doc.contact.name ? doc.contact.name : '',
    document_type: doc.document_type && doc.document_type.name ? doc.document_type.name : null,
    date: doc.emitted,
    year: m.year(),
    quarter: m.quarter(),
    supported,
    base,
    vat,
    deductible_pct: pct,
    deductible,
    balance: supported ? deductible : -vat,
    settled: !!settledDate,
    settled_date: settledDate,
    to: `/document/${doc.id}/${kind}`,
  };
}

// the rows that count: VAT not zero, a date, no draft issued invoice (issues/339)
function rowsOf(data, years) {
  const rows = [];
  for (const kind of Object.keys(KINDS)) {
    const key = kind.replace(/-(\w)/g, (_, c) => c.toUpperCase()); // received-invoices → receivedInvoices
    for (const doc of data[key] || []) {
      if (!Number(doc.total_vat) || !doc.emitted) continue;
      if (kind === 'emitted-invoices' && doc.state === 'draft') continue;
      rows.push(vatRow(doc, kind, years));
    }
  }
  return rows;
}

const sum = (rows, field) => round2(rows.reduce((s, r) => s + (r[field] || 0), 0));

function totalsOf(rows) {
  const charged = rows.filter((r) => !r.supported);
  const supported = rows.filter((r) => r.supported);
  const pending = rows.filter((r) => !r.settled);
  return {
    count: rows.length,
    received: sum(charged, 'vat'),
    paid: sum(supported, 'vat'),
    deductible_paid: sum(supported, 'deductible'),
    balance: sum(rows, 'balance'),
    settled_count: rows.length - pending.length,
    settled_balance: sum(rows.filter((r) => r.settled), 'balance'),
    pending_count: pending.length,
    pending_balance: sum(pending, 'balance'),
  };
}

const statusOf = (count, settledCount) => (settledCount === count ? 'settled' : settledCount ? 'partial' : 'pending');

/**
 * @param {object} data { emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses } of the year
 * @param {Array} years the «Anys» rows (year, deductible_vat_pct)
 * @param {number} year
 * @param {object} earlier the same lists, not settled, of the years before
 */
function vatSummary(data, years, year, earlier = {}) {
  const rows = rowsOf(data, years)
    .filter((r) => r.year === Number(year))
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const quarters = [1, 2, 3, 4]
    .map((quarter) => {
      const ofQuarter = rows.filter((r) => r.quarter === quarter);
      const totals = totalsOf(ofQuarter);
      return {
        year: Number(year),
        quarter,
        ...totals,
        status: statusOf(totals.count, totals.settled_count),
        payment_date: vatPaymentDate(Number(year), quarter).format(DAY),
      };
    })
    .filter((q) => q.count > 0);
  const before = rowsOf(earlier, years).filter((r) => r.year < Number(year) && !r.settled);
  return {
    year: Number(year),
    totals: totalsOf(rows),
    quarters,
    rows,
    earlier_pending: {
      count: before.length,
      balance: sum(before, 'balance'),
      years: [...new Set(before.map((r) => r.year))].sort(),
    },
  };
}

module.exports = { vatSummary, yearDeductiblePct };
