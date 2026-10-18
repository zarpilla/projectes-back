'use strict';
/* global strapi */

/**
 * Startup script (issues/179): contacts with a 4-digit postcode, «8225
 * Terrassa» for 08225. On Diligència 210 of the 214 came from two bulk loads
 * (2024-10-08 and 2024-12-11): a spreadsheet read the column as a number and
 * dropped the leading zero. Orders copy the contact's postcode, so the new
 * ones carried it too.
 *
 * A code is padded only when the result is certain: the contact is Spanish (no
 * country, or a Spanish one) and another contact of the same town already has
 * a 5-digit code of that province (the same first two digits). «8225
 * Terrassa» becomes 08225 because Terrassa has other 082xx contacts; «1780
 * Olot» (17800 with a zero missing at the end) and foreign codes (Belgium,
 * Switzerland… have 4 digits) are left alone and logged.
 *
 * Only the contacts: the orders keep the postcode they were made with (the
 * user's call, 2026-10-18).
 *
 * Idempotent: once padded, a code has 5 digits and is not picked again.
 */
const CONTACT = 'api::contact.contact';

const SPANISH = new Set(['es', 'esp', 'espanya', 'espana', 'spain', 'catalunya', 'paisos catalans']);

const plain = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const isSpanish = (country) => !plain(country) || SPANISH.has(plain(country));

/** The contacts whose postcode gets its leading zero back: [{ id, from, to }]. */
function paddedPostcodes(contacts) {
  // the provinces (first two digits) each town has 5-digit codes in
  const provinces = new Map();
  for (const c of contacts) {
    const code = String(c.postcode || '').trim();
    if (!/^\d{5}$/.test(code) || !plain(c.city)) continue;
    if (!provinces.has(plain(c.city))) provinces.set(plain(c.city), new Set());
    provinces.get(plain(c.city)).add(code.slice(0, 2));
  }
  const fixes = [];
  for (const c of contacts) {
    const code = String(c.postcode || '').trim();
    if (!/^\d{4}$/.test(code) || !isSpanish(c.country)) continue;
    const to = `0${code}`;
    const known = provinces.get(plain(c.city));
    if (known && known.has(to.slice(0, 2))) fixes.push({ id: c.id, from: c.postcode, to });
  }
  return fixes;
}

async function padFourDigitPostcodes() {
  const { tableName } = strapi.db.metadata.get(CONTACT);
  const contacts = await strapi.db.connection(tableName).select('id', 'postcode', 'city', 'country');
  const fixes = paddedPostcodes(contacts);
  for (const { id, from, to } of fixes) {
    // straight to the table: no lifecycles, and only while it still has the old code
    await strapi.db.connection(tableName).where({ id, postcode: from }).update({ postcode: to });
  }
  const fixed = new Set(fixes.map((f) => f.id));
  const left = contacts.filter((c) => /^\s*\d{4}\s*$/.test(String(c.postcode || '')) && !fixed.has(c.id));
  strapi.log.info(
    `[padFourDigitPostcodes] ${fixes.length} contacts got the leading zero of their postcode back; ` +
      `${left.length} 4-digit postcodes left as they are` +
      `${left.length ? ` (${left.map((c) => `#${c.id} ${String(c.postcode).trim()} ${c.city || ''}`.trim()).join(', ')})` : ''}`,
  );
}

module.exports = { padFourDigitPostcodes, paddedPostcodes, isSpanish };
