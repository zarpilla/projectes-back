'use strict';
/* global strapi */

/**
 * Startup script (issues/160): quotes whose `pdf` is a link to the front's old
 * quote preview (`<front_url>quote/<id>`).
 *
 * GET /quotes/:id filled an empty `pdf` with that link, and saving the quote
 * from the form stored it. The preview is gone; the PDF button asks the API,
 * which stores `/uploads/documents/...` again. The links are set back to empty.
 *
 * Idempotent: only `pdf` values outside /uploads/ that end in `quote/<id>`.
 */
const QUOTE = 'api::quote.quote';

async function clearQuotePreviewLinks() {
  const { tableName } = strapi.db.metadata.get(QUOTE);
  const rows = await strapi.db
    .connection(tableName)
    .select('id', 'pdf')
    .where('pdf', 'like', '%quote/%')
    .whereNot('pdf', 'like', '/uploads/%');
  const ids = rows.filter((r) => /quote\/\d+$/.test(r.pdf)).map((r) => r.id);
  if (ids.length) {
    await strapi.db.connection(tableName).whereIn('id', ids).update({ pdf: null });
  }
  strapi.log.info(`[clearQuotePreviewLinks] ${ids.length} quotes no longer link to the old preview`);
  return ids.length;
}

module.exports = { clearQuotePreviewLinks };
