'use strict';
/* global strapi */

/**
 * «Salda» on the IRPF page (issues/419): stamps `irpf_paid_date` on the
 * received invoices, received expenses and payrolls ticked, as «Salda» on
 * «IVA» stamps `vat_paid_date`. Only rows with IRPF and not settled yet; the
 * rest of the ids are ignored. Straight to the table, as the VAT one: a locked
 * invoice («Modificable» off) is settled too, and no lifecycle recomputes it.
 *
 * No Tresoreria movement is created: each document keeps its own IRPF row
 * there, dated on the settlement (services/irpf-summary.js, irpfMovement).
 */
const moment = require('moment');
const changeLog = require('../../../services/change-log');
const { round2 } = require('./balances');

const KINDS = {
  receivedInvoices: { uid: 'api::received-invoice.received-invoice', amount: 'total_irpf' },
  receivedExpenses: { uid: 'api::received-expense.received-expense', amount: 'total_irpf' },
  payrolls: { uid: 'api::payroll.payroll', amount: 'irpf_base' },
};
const FIELDS = ['irpf_paid_date'];

class IrpfSettleError extends Error {}

const idsOf = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];

/**
 * @param {object} body { receivedInvoices: [id], receivedExpenses: [id], payrolls: [id], irpf_paid_date }
 * @returns {{ date, count, total, settled: { receivedInvoices: [id], ... } }}
 */
async function settleIrpf(body = {}) {
  const date = body.irpf_paid_date;
  if (typeof date !== 'string' || !moment(date, 'YYYY-MM-DD', true).isValid()) {
    throw new IrpfSettleError('Cal la data del pagament (AAAA-MM-DD).');
  }
  const settled = {};
  let total = 0;
  let count = 0;
  for (const [key, { uid, amount }] of Object.entries(KINDS)) {
    settled[key] = [];
    const ids = idsOf(body[key]);
    if (!ids.length) continue;
    const rows = (
      await strapi.db.query(uid).findMany({ select: ['id', amount, 'irpf_paid_date'], where: { id: { $in: ids } } })
    ).filter((r) => Number(r[amount]) && !r.irpf_paid_date);
    if (!rows.length) continue;
    const { tableName } = strapi.db.metadata.get(uid);
    for (const row of rows) {
      const before = changeLog.isTracked(uid) ? await changeLog.rowWith(uid, { id: row.id }, FIELDS).catch(() => null) : null;
      // only while still unsettled: two «Salda» at once settle it once
      const updated = await strapi.db
        .connection(tableName)
        .where({ id: row.id })
        .whereNull('irpf_paid_date')
        .update({ irpf_paid_date: date });
      if (!updated) continue;
      await changeLog.logRawUpdate(uid, before, FIELDS);
      settled[key].push(row.id);
      total += Number(row[amount]) || 0;
      count += 1;
    }
  }
  return { date, count, total: round2(total), settled };
}

module.exports = { settleIrpf, IrpfSettleError, KINDS };
