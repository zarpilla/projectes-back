'use strict';

const moment = require('moment');
const { round2 } = require('./balances');

/**
 * IRPF page (issues/348): the withholdings the entity pays to Hisenda
 * (model 111) for a year, document by document and per quarter.
 *
 * - Received invoices and received expenses with `total_irpf`: paid the 20th
 *   after the document's quarter, as Tresoreria's «IRPF Factura» rows.
 * - Payrolls with `irpf_base`: paid on their own `irpf_date`, as Tresoreria's
 *   «IRPF Nòmina» rows (by default the 20th after the quarter too).
 *
 * The quarter is the document's (its emission date, or the payroll's month).
 * A row is paid once its payment date has passed, as Tresoreria counts the
 * invoices' IRPF (issues/242). The IRPF withheld from the entity on emitted
 * invoices is not paid by it and is not here.
 */

const quarterPaymentDate = (date) =>
  moment(date, 'YYYY-MM-DD').endOf('quarter').add(20, 'day').format('YYYY-MM-DD');

const pctOf = (irpf, base) => (base ? round2((irpf / base) * 100) : null);

function documentRow(doc, kind, today) {
  const date = doc.emitted;
  const m = moment(date, 'YYYY-MM-DD');
  const paymentDate = quarterPaymentDate(date);
  const irpf = round2(Number(doc.total_irpf) || 0);
  const base = round2(Number(doc.total_base) || 0);
  return {
    key: `${kind}:${doc.id}`,
    kind,
    id: doc.id,
    code: doc.code || '',
    contact: doc.contact && doc.contact.name ? doc.contact.name : '',
    document_type: doc.document_type && doc.document_type.name ? doc.document_type.name : null,
    date,
    year: m.year(),
    quarter: m.quarter(),
    base,
    irpf,
    pct: pctOf(irpf, base),
    payment_date: paymentDate,
    paid: paymentDate < today,
    to: `/document/${doc.id}/${kind}`,
  };
}

function payrollRow(payroll, today) {
  const year = payroll.year && payroll.year.year;
  const month = payroll.month && payroll.month.month;
  const date = year && month
    ? moment(`${year}-${month}-01`, 'YYYY-M-DD').endOf('month').format('YYYY-MM-DD')
    : payroll.emitted;
  const m = moment(date, 'YYYY-MM-DD');
  const paymentDate = payroll.irpf_date || quarterPaymentDate(date);
  const irpf = round2(Number(payroll.irpf_base) || 0);
  const base = round2(Number(payroll.total_base) || 0);
  const person = payroll.users_permissions_user && payroll.users_permissions_user.username
    ? payroll.users_permissions_user.username
    : '';
  return {
    key: `payrolls:${payroll.id}`,
    kind: 'payrolls',
    id: payroll.id,
    code: `${m.format('YYYY-MM')}-${person}`,
    contact: person,
    document_type: null,
    date,
    year: m.year(),
    quarter: m.quarter(),
    base,
    irpf,
    pct: pctOf(irpf, base),
    payment_date: paymentDate,
    paid: paymentDate < today,
    to: `/document/${payroll.id}/payrolls`,
  };
}

function quarterRows(rows, year) {
  const quarters = [1, 2, 3, 4].map((quarter) => ({
    year,
    quarter,
    payrolls: 0,
    payrolls_count: 0,
    documents: 0,
    documents_count: 0,
    total: 0,
    payment_dates: [],
    paid: true,
  }));
  for (const row of rows) {
    const q = quarters[row.quarter - 1];
    if (row.kind === 'payrolls') {
      q.payrolls += row.irpf;
      q.payrolls_count += 1;
    } else {
      q.documents += row.irpf;
      q.documents_count += 1;
    }
    q.total += row.irpf;
    if (!q.payment_dates.includes(row.payment_date)) q.payment_dates.push(row.payment_date);
    if (!row.paid) q.paid = false;
  }
  return quarters
    .filter((q) => q.payrolls_count + q.documents_count > 0)
    .map((q) => ({
      ...q,
      payrolls: round2(q.payrolls),
      documents: round2(q.documents),
      total: round2(q.total),
      payment_dates: q.payment_dates.sort(),
    }));
}

/**
 * @param {object} data { receivedInvoices, receivedExpenses, payrolls }
 * @param {number} year
 * @param {string} today YYYY-MM-DD
 */
function irpfSummary({ receivedInvoices = [], receivedExpenses = [], payrolls = [] }, year, today) {
  const rows = [
    ...receivedInvoices.filter((d) => Number(d.total_irpf) && d.emitted).map((d) => documentRow(d, 'received-invoices', today)),
    ...receivedExpenses.filter((d) => Number(d.total_irpf) && d.emitted).map((d) => documentRow(d, 'received-expenses', today)),
    ...payrolls.filter((p) => Number(p.irpf_base)).map((p) => payrollRow(p, today)),
  ]
    .filter((r) => r.year === Number(year))
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  const total = round2(rows.reduce((s, r) => s + r.irpf, 0));
  const paid = round2(rows.filter((r) => r.paid).reduce((s, r) => s + r.irpf, 0));
  const pending = rows.filter((r) => !r.paid);
  let next = null;
  if (pending.length) {
    const date = pending.map((r) => r.payment_date).sort()[0];
    next = { date, amount: round2(pending.filter((r) => r.payment_date === date).reduce((s, r) => s + r.irpf, 0)) };
  }

  return {
    year: Number(year),
    today,
    totals: { total, paid, pending: round2(total - paid), next },
    quarters: quarterRows(rows, Number(year)),
    rows,
  };
}

module.exports = { irpfSummary, quarterPaymentDate };
