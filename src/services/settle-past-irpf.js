'use strict';
/* global strapi */

/**
 * Startup script (issues/419): IRPF gets «Salda», and a document not settled
 * is pending until it is (services/irpf-summary.js). Nobody has settled IRPF
 * before, so what was shown as paid then is settled on its payment date, and
 * Tresoreria keeps its history (user decision, 2026-11-09):
 *
 * - received invoices and received expenses with IRPF whose payment date (the
 *   20th after their quarter) has passed;
 * - paid payrolls with IRPF whose IRPF date (or the 20th after their quarter)
 *   has passed.
 *
 * An unpaid payroll past its IRPF date was already shown as overdue: it stays
 * pending. Only rows with no `irpf_paid_date`; rerunning changes nothing.
 */
const moment = require('moment');
const { quarterPaymentDate, dayOf } = require('../api/treasury/services/irpf-summary');

const INVOICE = 'api::received-invoice.received-invoice';
const EXPENSE = 'api::received-expense.received-expense';
const PAYROLL = 'api::payroll.payroll';

const notZero = { $ne: 0, $notNull: true };

function payrollDeadline(payroll) {
  if (payroll.irpf_date) return dayOf(payroll.irpf_date);
  const year = payroll.year && payroll.year.year;
  const month = payroll.month && payroll.month.month;
  const date = year && month ? moment(`${year}-${month}-01`, 'YYYY-M-DD').endOf('month').format('YYYY-MM-DD') : payroll.emitted;
  return date ? quarterPaymentDate(date) : null;
}

// { date: [ids] } → one UPDATE per date, only while still unsettled
async function stamp(uid, byDate) {
  const { tableName } = strapi.db.metadata.get(uid);
  let updated = 0;
  for (const [date, ids] of Object.entries(byDate)) {
    for (let i = 0; i < ids.length; i += 500) {
      updated += await strapi.db
        .connection(tableName)
        .whereIn('id', ids.slice(i, i + 500))
        .whereNull('irpf_paid_date')
        .update({ irpf_paid_date: date });
    }
  }
  return updated;
}

function groupByDate(rows, deadlineOf, today) {
  const byDate = {};
  for (const row of rows) {
    const date = deadlineOf(row);
    if (!date || date >= today) continue;
    (byDate[date] = byDate[date] || []).push(row.id);
  }
  return byDate;
}

async function settlePastIrpf(today = moment().format('YYYY-MM-DD')) {
  const counts = {};
  for (const uid of [INVOICE, EXPENSE]) {
    const rows = await strapi.db.query(uid).findMany({
      select: ['id', 'emitted'],
      where: { total_irpf: notZero, emitted: { $notNull: true }, irpf_paid_date: { $null: true } },
    });
    counts[uid] = await stamp(uid, groupByDate(rows, (r) => quarterPaymentDate(r.emitted), today));
  }
  const payrolls = await strapi.db.query(PAYROLL).findMany({
    select: ['id', 'emitted', 'irpf_date', 'paid'],
    where: { irpf_base: notZero, paid: true, irpf_paid_date: { $null: true } },
    populate: { year: { select: ['year'] }, month: { select: ['month'] } },
  });
  counts[PAYROLL] = await stamp(PAYROLL, groupByDate(payrolls, payrollDeadline, today));
  strapi.log.info(
    `[settlePastIrpf] settled: ${counts[INVOICE]} received invoices, ${counts[EXPENSE]} received expenses, ${counts[PAYROLL]} payrolls`,
  );
  return counts;
}

module.exports = { settlePastIrpf, payrollDeadline };
