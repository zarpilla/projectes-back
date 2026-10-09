'use strict';
/* global strapi */

/**
 * Startup script (issues/022): recompute the quote totals v5 saved as 0.00.
 *
 * Until the fix, the quote lifecycle summed the bare `{ id }` line references
 * v5 leaves in the payload, so every quote saved on v5 had all totals at 0.
 * Same approach as recalcZeroDocumentTotals: only quotes stored at 0 whose
 * lines add up to something else are touched, written straight to the table.
 * Quotes don't feed the project totals, so nothing is marked dirty.
 */
const { computeQuoteTotals } = require('./document-lifecycle');

const UID = 'api::quote.quote';
const EPSILON = 0.005;
const isZero = (v) => Math.abs(Number(v) || 0) < EPSILON;
const round2 = (v) => Math.round(v * 100) / 100;

async function recalcZeroQuoteTotals() {
  if (!strapi.contentTypes[UID]) return;
  const { tableName } = strapi.db.metadata.get(UID);
  const quotes = await strapi.db.query(UID).findMany({
    where: { $or: [{ total: 0 }, { total: null }] },
    populate: { lines: true },
  });

  let fixed = 0;
  for (const quote of quotes) {
    if (!isZero(quote.total_base) || !isZero(quote.total_vat)) continue;
    const totals = computeQuoteTotals(quote.lines);
    if (isZero(totals.total_base) && isZero(totals.total)) continue;
    await strapi.db
      .connection(tableName)
      .where({ id: quote.id })
      .update({
        total_base: round2(totals.total_base),
        total_vat: round2(totals.total_vat),
        total_irpf: 0,
        total: round2(totals.total),
      });
    fixed += 1;
    strapi.log.info(`[recalcZeroQuoteTotals] quote #${quote.id} (${quote.code || '-'}): total 0 -> ${round2(totals.total)}`);
  }
  strapi.log.info(`[recalcZeroQuoteTotals] ${fixed} of ${quotes.length} zero-total quotes recalculated`);
}

module.exports = { recalcZeroQuoteTotals };
