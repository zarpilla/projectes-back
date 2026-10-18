'use strict';

/**
 * The postcode of each town, for the delivery point form (issues/182): picking
 * the town left the CP empty, and the towns have no postcode of their own. It
 * is the 5-digit code most used by the contacts of that town; only the town
 * and the code go out, no contact.
 */
const plain = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** { "terrassa": "08225", … } from rows of { city, postcode }. */
function townPostcodes(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const code = String(r.postcode || '').trim();
    const town = plain(r.city);
    if (!town || !/^\d{5}$/.test(code)) continue;
    if (!counts.has(town)) counts.set(town, new Map());
    const byCode = counts.get(town);
    byCode.set(code, (byCode.get(code) || 0) + 1);
  }
  const out = {};
  for (const [town, byCode] of counts) {
    // the most used; on a tie, the lowest code, so the answer doesn't change
    out[town] = [...byCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  return out;
}

module.exports = { townPostcodes, plain };
