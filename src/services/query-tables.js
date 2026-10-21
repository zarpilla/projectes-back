'use strict';

/**
 * The tables a db.query findMany of `uid` with `populate` reads: the entity's
 * table and, for each populated relation or component, its link table and the
 * target's tables (recursively with a nested populate).
 *
 * Declared to the read cache (issues/307, 309) so their MySQL stamps are read
 * before the first load: without them the first result can't be trusted and
 * is loaded twice. Only what the query reads: a declared table is also a
 * dependency, and a write to a table the result doesn't come from would drop
 * it for nothing.
 */
const RELATIONAL = new Set(['relation', 'component', 'media', 'dynamiczone']);

function queryTables(strapi, uid, populate, out = new Set()) {
  let meta;
  try {
    meta = strapi.db.metadata.get(uid);
  } catch {
    return out;
  }
  if (!meta) return out;
  out.add(String(meta.tableName).toLowerCase());
  if (!populate) return out;

  const all = populate === true || populate === '*';
  const entries = all
    ? Object.keys(meta.attributes || {})
        .filter((name) => RELATIONAL.has(meta.attributes[name].type) || meta.attributes[name].joinTable)
        .map((name) => [name, true])
    : Object.entries(populate);

  for (const [name, sub] of entries) {
    const attr = meta.attributes && meta.attributes[name];
    if (!attr || !sub) continue;
    if (attr.joinTable && attr.joinTable.name) out.add(String(attr.joinTable.name).toLowerCase());
    // media and other morph relations: the link table is on the target's side
    // (files_related_mph for the upload plugin's files)
    if (attr.morphBy && attr.target) {
      try {
        const side = strapi.db.metadata.get(attr.target).attributes[attr.morphBy];
        if (side && side.joinTable && side.joinTable.name) out.add(String(side.joinTable.name).toLowerCase());
      } catch {
        // unknown target: its table is still added below
      }
    }
    const nested = sub && typeof sub === 'object' ? sub.populate || null : null;
    const target = attr.target || attr.component;
    if (target) queryTables(strapi, target, nested, out);
  }
  return out;
}

module.exports = { queryTables };
