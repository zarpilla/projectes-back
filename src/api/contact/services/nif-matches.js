'use strict';

/**
 * The contacts that already have a NIF, for the warning of the contact form.
 *
 * A NIF is compared without case, spaces, dashes or dots ("b-12.345.678" is
 * "B12345678"). Delivery points (contacts with an owner) are left out on both
 * sides: in Diligència one organisation has several points under the same NIF,
 * and that is how it should be.
 */

const nifKey = (nif) => String(nif || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A NIF this short is a typo or a placeholder, not worth a warning.
const MIN_KEY_LENGTH = 5;

function nifMatches(contacts, nif, excludeId = null) {
  const key = nifKey(nif);
  if (key.length < MIN_KEY_LENGTH) return [];
  const exclude = excludeId == null || excludeId === '' ? null : Number(excludeId);
  return contacts
    .filter((c) => !c.owner && c.id !== exclude && nifKey(c.nif) === key)
    .map(({ id, name, trade_name, nif: n }) => ({ id, name, trade_name, nif: n }));
}

// The SQL side of nifKey for the usual separators; nifMatches still compares
// exactly, so another separator only means a missed warning.
const NIF_KEY_SQL = "UPPER(REPLACE(REPLACE(REPLACE(REPLACE(nif, ' ', ''), '-', ''), '.', ''), '/', ''))";

async function findNifMatches(strapi, nif, excludeId) {
  const key = nifKey(nif);
  if (key.length < MIN_KEY_LENGTH) return [];
  // Normalised in SQL: a LIKE on the stored text misses "B-12.345.678".
  const rows = await strapi.db.connection('contacts').select('id').whereRaw(`${NIF_KEY_SQL} = ?`, [key]);
  if (!rows.length) return [];
  const contacts = await strapi.db.query('api::contact.contact').findMany({
    select: ['id', 'name', 'trade_name', 'nif'],
    where: { id: { $in: rows.map((r) => r.id) } },
    populate: { owner: { select: ['id'] } },
  });
  return nifMatches(contacts, nif, excludeId);
}

module.exports = { nifKey, nifMatches, findNifMatches, MIN_KEY_LENGTH };
