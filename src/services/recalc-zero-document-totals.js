'use strict';
/* global strapi */

/**
 * Startup script: recompute the totals v5 saved as 0.00.
 *
 * Until the fix in document-lifecycle.js, every save of a document with lines
 * summed the bare `{ id }` references v5 leaves in the lifecycle payload, so the
 * document was stored with total_base = total_vat = total_irpf = total = 0 —
 * and /stats and the treasury showed it as 0.
 *
 * Only documents stored at 0 whose lines add up to something else are touched:
 * a legitimately-zero document stays as is, and a non-zero total someone set
 * is never overwritten. The write goes straight to the table — through the
 * entity layer the `updatable` guard would refuse closed documents, and those
 * are exactly the ones whose wrong total matters most. The linked projects are
 * then marked dirty so their stored totals follow.
 */
const { computeLineTotals } = require('./document-lifecycle');
const { scheduleFromEntityProjects } = require('../api/project/services/totalsRefreshScheduler');

// The content types built on createDocumentLifecycles({ hasLines: true }).
const DOCUMENT_UIDS = [
  'api::received-invoice.received-invoice',
  'api::received-expense.received-expense',
  'api::received-income.received-income',
  'api::diet.diet',
  'api::ticket.ticket',
];

const EPSILON = 0.005;
const isZero = (v) => Math.abs(Number(v) || 0) < EPSILON;
const round2 = (v) => Math.round(v * 100) / 100;

async function recalcZeroDocumentTotals() {
  for (const uid of DOCUMENT_UIDS) {
    if (!strapi.contentTypes[uid]) continue;
    const { tableName } = strapi.db.metadata.get(uid);

    const docs = await strapi.db.query(uid).findMany({
      where: { $or: [{ total: 0 }, { total: null }] },
      populate: { lines: true, project: true, projects: true },
    });

    let fixed = 0;
    for (const doc of docs) {
      if (!isZero(doc.total_base) || !isZero(doc.total_vat) || !isZero(doc.total_irpf)) continue;
      const totals = computeLineTotals(doc.lines);
      if (isZero(totals.total_base) && isZero(totals.total)) continue;

      await strapi.db
        .connection(tableName)
        .where({ id: doc.id })
        .update({
          total_base: round2(totals.total_base),
          total_vat: round2(totals.total_vat),
          total_irpf: round2(totals.total_irpf),
          total: round2(totals.total),
        });
      scheduleFromEntityProjects(doc);
      fixed += 1;
      strapi.log.info(`[recalcZeroDocumentTotals] ${uid} #${doc.id} (${doc.code || '-'}): total 0 -> ${round2(totals.total)}`);
    }
    strapi.log.info(`[recalcZeroDocumentTotals] ${uid}: ${fixed} of ${docs.length} zero-total documents recalculated`);
  }
}

module.exports = { recalcZeroDocumentTotals };
