'use strict';

/**
 * Previsió de facturació: the planned incomes of the projects (project_phases.incomes)
 * that still have no document, and what was invoiced per month.
 *
 * A planned income is pending when it is not paid, has no emitted invoice and no
 * received income linked, and its amount is not zero. Its date is the
 * "Previsió fac." (date_estimate_document), else the payment date (date).
 * The report filters these rows (project state, grants, horizon) in the front end.
 */

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
const linked = (rel) => !!(rel && rel.id);
const personName = (u) => (u ? u.fullname || u.username || null : null);

const isPending = (income) =>
  !income.paid && !linked(income.invoice) && !linked(income.income) && num(income.total_amount) !== 0;

/**
 * @param {object[]} projects  with project_phases.incomes (client, income_type, invoice, income),
 *                             project_state, project_likelihood, leader and clients populated
 * @returns {object[]} one row per pending planned income
 */
function pendingInvoicingRows(projects) {
  const rows = [];
  for (const p of projects || []) {
    if (p.is_mother === true) continue;
    const projectClient = (p.clients || [])[0] || null;
    for (const phase of p.project_phases || []) {
      for (const i of phase.incomes || []) {
        if (!isPending(i)) continue;
        const base = num(i.total_amount);
        const type = i.income_type || null;
        const vat = i.vat_pct !== null && i.vat_pct !== undefined ? num(i.vat_pct) : num(type && type.vat_pct);
        const invoiceDate = i.date_estimate_document || null;
        const paymentDate = i.date || null;
        const client = i.client || projectClient;
        rows.push({
          id: i.id,
          concept: i.concept || null,
          phase_name: phase.name || null,
          base: round2(base),
          vat_pct: vat,
          total: round2(base * (1 + vat / 100)),
          date: invoiceDate || paymentDate,
          date_source: invoiceDate ? 'invoice' : paymentDate ? 'payment' : null,
          project_id: p.id,
          project_name: p.name,
          state_id: p.project_state ? p.project_state.id : null,
          state_name: p.project_state ? p.project_state.name : null,
          likelihood_name: p.project_likelihood ? p.project_likelihood.name : null,
          leader_id: p.leader ? p.leader.id : null,
          leader_name: personName(p.leader),
          client_name: client ? client.name : null,
          client_from_project: !i.client && !!projectClient,
          income_type_id: type ? type.id : null,
          income_type_name: type ? type.name : null,
        });
      }
    }
  }
  return rows;
}

/**
 * Base of the emitted invoices per month ("YYYY-MM"), from `fromDate` on.
 * Rectifying invoices carry negative bases and subtract.
 */
function invoicedByMonth(invoices, fromDate) {
  const out = {};
  for (const inv of invoices || []) {
    if (!inv.emitted || (fromDate && inv.emitted < fromDate)) continue;
    const ym = String(inv.emitted).slice(0, 7);
    out[ym] = round2((out[ym] || 0) + num(inv.total_base));
  }
  return out;
}

/** Relations the controller must populate on each project. */
const PROJECT_POPULATE = {
  project_state: true,
  project_likelihood: true,
  leader: true,
  clients: true,
  project_phases: {
    populate: {
      incomes: { populate: { client: true, income_type: true, invoice: true, income: true } },
    },
  },
};

module.exports = { isPending, pendingInvoicingRows, invoicedByMonth, PROJECT_POPULATE };
