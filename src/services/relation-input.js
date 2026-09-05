'use strict';

/**
 * Reading a relation out of a lifecycle payload.
 *
 * v3 lifecycle hooks saw relations exactly as the caller sent them — an id, or
 * an object with `.id`. By the time a v5 **db** lifecycle runs, the Document
 * Service has already normalised them into relation operations, so the value is
 * shaped like `{ set: [{ id: 5 }] }` (or `connect` / `disconnect`). Ported code
 * doing `data.route.id ? … : data.route` therefore reads an operation object and
 * feeds it straight into a `where`, which fails with
 * "Undefined attribute level operator set".
 *
 * `relationId(value)` returns the numeric id for every shape the two versions
 * can produce, or undefined when the relation is absent or being cleared.
 */
function relationId(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? Number(value) : value;
  if (Array.isArray(value)) return relationId(value[0]);
  if (typeof value !== 'object') return undefined;

  // v5 relation operations, in the order the Document Service emits them
  for (const op of ['set', 'connect']) {
    if (value[op] !== undefined) return relationId(value[op]);
  }
  if (value.id !== undefined) return relationId(value.id);
  if (value.documentId !== undefined) return value.documentId;
  return undefined;
}

module.exports = { relationId };
