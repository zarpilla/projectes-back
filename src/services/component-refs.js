'use strict';
/* global strapi */

/**
 * Reading component VALUES inside a db lifecycle.
 *
 * By the time a v5 db lifecycle runs, the Document Service has already written
 * the component rows and replaced each one in the payload with a bare
 * reference — `{ id, __pivot }` — so the values the caller sent (a
 * periodification's `year`, `incomes`, …) are gone from `event.params.data`.
 * v3 handed the model the raw objects. Code that reads those values (the
 * project financials, an invoice's totals) has to read the rows back.
 *
 * Never resolve `event.params.data` itself: the references are what Strapi
 * links after the hook. Resolve a copy.
 */

const isRef = (value) =>
  value !== null &&
  typeof value === 'object' &&
  value.id !== undefined &&
  Object.keys(value).every((key) => key === 'id' || key === '__pivot');

/**
 * Replaces, in `data`, every component reference with the stored row.
 *
 * @param {string} uid   content-type uid whose component attributes to resolve
 * @param {object} data  payload copy (mutated)
 * @returns {Promise<object>} the same `data`
 */
async function resolveComponentRefs(uid, data) {
  const { attributes } = strapi.contentType(uid);
  for (const [field, attribute] of Object.entries(attributes)) {
    if (attribute.type !== 'component') continue;
    const value = data[field];
    if (value === null || value === undefined) continue;

    const list = Array.isArray(value) ? value : [value];
    const refs = list.filter(isRef);
    if (refs.length === 0) continue;

    const rows = await strapi.db
      .query(attribute.component)
      .findMany({ where: { id: { $in: refs.map((ref) => ref.id) } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved = list.map((item) => (isRef(item) && byId.has(item.id) ? byId.get(item.id) : item));
    data[field] = Array.isArray(value) ? resolved : resolved[0];
  }
  return data;
}

module.exports = { resolveComponentRefs, isRef };
