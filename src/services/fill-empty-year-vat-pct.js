'use strict';
/* global strapi */

/**
 * Startup script (issues/338): years with no «% IVA deduïble» (Taules
 * auxiliars › Anys) get 100 %. An empty year was read as 0 % in «IVA» and the
 * Tresoreria VAT rows, 100 % in the project totals and Configuració's % in
 * «Salda». The user decided (2026-10-24) that an empty year is 100 %: the
 * project totals already used 100 %, so they don't change; only the VAT still
 * pending of those years does (unsettled VAT of a past year means the entity
 * doesn't manage it in the app).
 *
 * Only the empty ones: a % someone typed in (0 included) is never touched.
 * Idempotent: once set, a year is not empty any more.
 */
const YEAR = 'api::year.year';

async function fillEmptyYearVatPct() {
  const empty = (
    await strapi.db.query(YEAR).findMany({ select: ['id', 'year', 'deductible_vat_pct'] })
  ).filter((y) => y.deductible_vat_pct === null || y.deductible_vat_pct === undefined);
  if (!empty.length) {
    return;
  }
  const { tableName } = strapi.db.metadata.get(YEAR);
  // straight to the table, and only while still empty
  const updated = await strapi.db
    .connection(tableName)
    .whereIn(
      'id',
      empty.map((y) => y.id),
    )
    .whereNull('deductible_vat_pct')
    .update({ deductible_vat_pct: 100 });
  const years = empty
    .map((y) => y.year)
    .sort((a, b) => a - b)
    .join(', ');
  strapi.log.info(`[fillEmptyYearVatPct] ${updated} years without «% IVA deduïble» set to 100: ${years}`);
}

module.exports = { fillEmptyYearVatPct };
