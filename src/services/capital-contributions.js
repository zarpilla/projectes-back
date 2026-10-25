'use strict';
/* global strapi */

/**
 * A contact's contributions to the cooperative's capital (2026-10-25): the
 * repeatable component `capital_contributions` (partners.capital-contribution:
 * date, amount, comment). Logistics members (diligencia) and the energy
 * community's members both have them.
 *
 * Before, a contact had one amount and one date (`partner_amount`,
 * `partner_amount_date`). Those two columns stay as a summary kept by the
 * contact lifecycles: the total of the contributions and the date of the last
 * one. The lists that read them (Rutes i punts › Sòcies, its export) keep
 * working without loading the component. They are not edited by hand any more.
 *
 * `migratePartnerAmounts` (run-once startup script) turned each contact's old
 * amount and date into its first contribution.
 */

const CONTACT = 'api::contact.contact';

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * The rows as they are saved: date 'YYYY-MM-DD' or null, amount a number or
 * null, comment or null. Fully empty rows (a line added and left blank) go.
 * Throws (status 400) on an amount that is not a number or a wrong date.
 */
function cleanContributions(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const date = blank(row.date) ? null : String(row.date).slice(0, 10);
    const rawAmount = blank(row.amount) ? null : String(row.amount).trim().replace(',', '.');
    const comment = blank(row.comment) ? null : String(row.comment).trim();
    if (date === null && rawAmount === null && comment === null) continue;
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
      throw badRequest('La data d’una aportació no és vàlida');
    }
    const amount = rawAmount === null ? null : Number(rawAmount);
    if (amount !== null && !Number.isFinite(amount))
      throw badRequest('L’import d’una aportació ha de ser un número');
    const clean = { date, amount, comment };
    if (row.id) clean.id = row.id;
    out.push(clean);
  }
  return out;
}

/** { partner_amount, partner_amount_date }: the total and the last date, null when none. */
function summarize(rows) {
  const list = (rows || []).filter((r) => r && (!blank(r.amount) || !blank(r.date)));
  if (!list.length) return { partner_amount: null, partner_amount_date: null };
  const withAmount = list.filter((r) => !blank(r.amount));
  const total = withAmount.length
    ? Math.round(withAmount.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
    : null;
  const dates = list
    .map((r) => (blank(r.date) ? null : String(r.date).slice(0, 10)))
    .filter(Boolean)
    .sort();
  return { partner_amount: total, partner_amount_date: dates.length ? dates[dates.length - 1] : null };
}

/**
 * Writes the summary of the contact's contributions in its two old columns.
 * Through the query layer, which joins the transaction of the save that called
 * it (raw knex waited on that transaction's lock); the lifecycles it runs again
 * see no contributions in the data and leave it there.
 */
async function refreshContactCapital(contactId, app = global.strapi) {
  if (!contactId) return null;
  const contact = await app.db
    .query(CONTACT)
    .findOne({ where: { id: contactId }, select: ['id'], populate: { capital_contributions: true } });
  if (!contact) return null;
  const summary = summarize(contact.capital_contributions);
  await app.db.query(CONTACT).update({ where: { id: contactId }, data: summary });
  return summary;
}

/**
 * Run-once startup script: each contact with an old amount or date and no
 * contributions yet gets them as its first contribution. Nothing is deleted:
 * the old columns keep the same values (now the summary).
 */
async function migratePartnerAmounts() {
  const contacts = await strapi.db.query(CONTACT).findMany({
    where: { $or: [{ partner_amount: { $notNull: true } }, { partner_amount_date: { $notNull: true } }] },
    select: ['id', 'documentId', 'partner_amount', 'partner_amount_date'],
    populate: { capital_contributions: true },
  });
  const moved = [];
  for (const contact of contacts) {
    if ((contact.capital_contributions || []).length) continue;
    const date = contact.partner_amount_date ? String(contact.partner_amount_date).slice(0, 10) : null;
    const amount =
      contact.partner_amount === null || contact.partner_amount === undefined
        ? null
        : Number(contact.partner_amount);
    await strapi.documents(CONTACT).update({
      documentId: contact.documentId,
      data: { capital_contributions: [{ date, amount, comment: null }] },
    });
    moved.push(contact.id);
  }
  strapi.log.info(
    `[migratePartnerAmounts] ${moved.length} contacts got their amount as a first contribution` +
      (moved.length ? ` (${moved.map((id) => `#${id}`).join(', ')})` : ''),
  );
  return moved;
}

module.exports = { cleanContributions, summarize, refreshContactCapital, migratePartnerAmounts };
