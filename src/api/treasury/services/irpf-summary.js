'use strict';

const moment = require('moment');
const { round2 } = require('./balances');

/**
 * IRPF page (issues/348): the withholdings the entity pays to Hisenda
 * (model 111) for a year, document by document and per quarter.
 *
 * - Received invoices and received expenses with `total_irpf`: due the 20th
 *   after the document's quarter, as Tresoreria's «IRPF Factura» rows.
 * - Payrolls with `irpf_base`: due on their own `irpf_date`, as Tresoreria's
 *   «IRPF Nòmina» rows (by default the 20th after the quarter too).
 *
 * The quarter is the document's (its emission date, or the payroll's month).
 * The IRPF withheld from the entity on emitted invoices is not paid by it and
 * is not here.
 *
 * Settling (issues/419): «Salda» stamps `irpf_paid_date` on the documents
 * ticked. A settled document is paid on that date. One not settled is pending:
 * on its own date while that is still ahead, and once it has passed (left out
 * of a settlement, or entered after it) on the next model 111 date, so it adds
 * up into the next declaration. Before 419 «paid» was guessed from the dates
 * and the payroll's paid state; nothing is settled automatically on deploy
 * (user decision 2026-11-09): the tenants settle past quarters with «Salda».
 */

const DAY = 'YYYY-MM-DD';

const quarterPaymentDate = (date) => moment(date, DAY).endOf('quarter').add(20, 'day').format(DAY);

// the first model 111 date (the 20th of January, April, July, October) on or after `today`
function nextDeclarationDate(today) {
  const m = moment(today, DAY);
  for (let i = 0; i < 5; i += 1) {
    const date = quarterPaymentDate(m.clone().subtract(1, 'quarter').add(i, 'quarter'));
    if (date >= today) return date;
  }
  return quarterPaymentDate(m);
}

// «2026-04-20», a Date or empty → «YYYY-MM-DD» or null
function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) return moment(value).format(DAY);
  return String(value).slice(0, 10);
}

/**
 * When and whether an IRPF payment happens, for the IRPF page and Tresoreria.
 * `deadline`: the document's own date (null when unknown); `settled`: its
 * irpf_paid_date. → { date, paid, late } with date «YYYY-MM-DD» or null.
 */
function irpfMovement(deadline, settled, today) {
  const settledDay = dayOf(settled);
  if (settledDay) return { date: settledDay, paid: true, late: false };
  if (!deadline) return { date: null, paid: false, late: false };
  if (deadline >= today) return { date: deadline, paid: false, late: false };
  return { date: nextDeclarationDate(today), paid: false, late: true };
}

const pctOf = (irpf, base) => (base ? round2((irpf / base) * 100) : null);

function documentRow(doc, kind, today) {
  const date = doc.emitted;
  const m = moment(date, DAY);
  const deadline = quarterPaymentDate(date);
  const irpf = round2(Number(doc.total_irpf) || 0);
  const base = round2(Number(doc.total_base) || 0);
  const movement = irpfMovement(deadline, doc.irpf_paid_date, today);
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
    deadline,
    payment_date: movement.date,
    paid: movement.paid,
    late: movement.late,
    settled_date: dayOf(doc.irpf_paid_date),
    to: `/document/${doc.id}/${kind}`,
  };
}

// the payroll's day: the end of its month
function payrollDate(payroll) {
  const year = payroll.year && payroll.year.year;
  const month = payroll.month && payroll.month.month;
  return year && month ? moment(`${year}-${month}-01`, 'YYYY-M-DD').endOf('month').format(DAY) : payroll.emitted;
}

function payrollRow(payroll, today) {
  const date = payrollDate(payroll);
  const m = moment(date, DAY);
  const deadline = dayOf(payroll.irpf_date) || quarterPaymentDate(date);
  const irpf = round2(Number(payroll.irpf_base) || 0);
  const base = round2(Number(payroll.total_base) || 0);
  const movement = irpfMovement(deadline, payroll.irpf_paid_date, today);
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
    deadline,
    payment_date: movement.date,
    paid: movement.paid,
    late: movement.late,
    settled_date: dayOf(payroll.irpf_paid_date),
    to: `/document/${payroll.id}/payrolls`,
  };
}

// settled: every row settled; pending: none; partial: some
const statusOf = (count, settledCount) => (settledCount === count ? 'settled' : settledCount ? 'partial' : 'pending');

function quarterRows(rows, year) {
  const quarters = [1, 2, 3, 4].map((quarter) => ({
    year,
    quarter,
    payrolls: 0,
    payrolls_count: 0,
    documents: 0,
    documents_count: 0,
    total: 0,
    settled: 0,
    settled_count: 0,
    pending: 0,
    deadline: quarterPaymentDate(moment(`${year}`, 'YYYY').quarter(quarter)),
    payment_dates: [],
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
    if (row.paid) {
      q.settled += row.irpf;
      q.settled_count += 1;
    } else {
      q.pending += row.irpf;
    }
    if (row.payment_date && !q.payment_dates.includes(row.payment_date)) q.payment_dates.push(row.payment_date);
  }
  return quarters
    .filter((q) => q.payrolls_count + q.documents_count > 0)
    .map((q) => {
      const count = q.payrolls_count + q.documents_count;
      return {
        ...q,
        count,
        payrolls: round2(q.payrolls),
        documents: round2(q.documents),
        total: round2(q.total),
        settled: round2(q.settled),
        pending: round2(q.pending),
        status: statusOf(count, q.settled_count),
        paid: q.settled_count === count,
        payment_dates: q.payment_dates.sort(),
      };
    });
}

const sumIrpf = (rows) => round2(rows.reduce((s, r) => s + r.irpf, 0));

/**
 * @param {object} data { receivedInvoices, receivedExpenses, payrolls } of the year
 * @param {number} year
 * @param {string} today YYYY-MM-DD
 * @param {object} earlier the same lists, not settled, of the years before
 */
function irpfSummary(data, year, today, earlier = {}) {
  const rowsOf = ({ receivedInvoices = [], receivedExpenses = [], payrolls = [] }) => [
    ...receivedInvoices.filter((d) => Number(d.total_irpf) && d.emitted).map((d) => documentRow(d, 'received-invoices', today)),
    ...receivedExpenses.filter((d) => Number(d.total_irpf) && d.emitted).map((d) => documentRow(d, 'received-expenses', today)),
    ...payrolls.filter((p) => Number(p.irpf_base)).map((p) => payrollRow(p, today)),
  ];
  const rows = rowsOf(data)
    .filter((r) => r.year === Number(year))
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

  const total = sumIrpf(rows);
  const settled = sumIrpf(rows.filter((r) => r.paid));
  const pending = rows.filter((r) => !r.paid);
  let next = null;
  const dates = pending.map((r) => r.payment_date).filter(Boolean).sort();
  if (dates.length) {
    next = { date: dates[0], amount: sumIrpf(pending.filter((r) => r.payment_date === dates[0])) };
  }

  // not settled from the years before: they go into the next declaration too
  const before = rowsOf(earlier).filter((r) => r.year < Number(year) && !r.paid);

  return {
    year: Number(year),
    today,
    totals: {
      total,
      paid: settled,
      pending: round2(total - settled),
      pending_count: pending.length,
      late: sumIrpf(pending.filter((r) => r.late)),
      next,
    },
    quarters: quarterRows(rows, Number(year)),
    rows,
    earlier_pending: {
      count: before.length,
      amount: sumIrpf(before),
      years: [...new Set(before.map((r) => r.year))].sort(),
    },
  };
}

module.exports = { irpfSummary, irpfMovement, nextDeclarationDate, quarterPaymentDate, dayOf };
