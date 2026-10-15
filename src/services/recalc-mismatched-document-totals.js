'use strict';
/* global strapi */

/**
 * Startup script (issues/045): recompute the stored totals that don't match
 * the document's lines.
 *
 * Until the issues/002 repair, migrated lines showed twice in the form, so a
 * document saved in that window stored twice its real total. The repair
 * removed the duplicate lines but not those totals: the lists, /stats and the
 * exports kept showing the doubled amount while the form showed the right one.
 *
 * Only documents with lines whose stored totals differ from them by more than
 * a cent are touched; the ones without lines take their totals from the base
 * fields and are left alone. Like recalcZeroDocumentTotals, the write goes
 * straight to the table (the `updatable` guard would refuse closed documents)
 * and the linked projects are marked dirty so their stored totals follow.
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

const FIELDS = ['total_base', 'total_vat', 'total_irpf', 'total'];
const TOLERANCE = 0.011;
const round2 = (v) => Math.round(v * 100) / 100;

async function recalcMismatchedDocumentTotals() {
  for (const uid of DOCUMENT_UIDS) {
    if (!strapi.contentTypes[uid]) continue;
    const { tableName } = strapi.db.metadata.get(uid);

    const docs = await strapi.db.query(uid).findMany({
      populate: { lines: true, project: true, projects: true },
    });

    let fixed = 0;
    for (const doc of docs) {
      if (!doc.lines || doc.lines.length === 0) continue;
      const computed = computeLineTotals(doc.lines);
      const totals = Object.fromEntries(FIELDS.map((f) => [f, round2(computed[f])]));
      if (FIELDS.every((f) => Math.abs((Number(doc[f]) || 0) - totals[f]) < TOLERANCE)) continue;

      await strapi.db.connection(tableName).where({ id: doc.id }).update(totals);
      scheduleFromEntityProjects(doc);
      fixed += 1;
      strapi.log.info(`[recalcMismatchedDocumentTotals] ${uid} #${doc.id} (${doc.code || '-'}): total ${doc.total} -> ${totals.total}`);
    }
    strapi.log.info(`[recalcMismatchedDocumentTotals] ${uid}: ${fixed} of ${docs.length} documents recalculated`);
  }
}

module.exports = { recalcMismatchedDocumentTotals };
