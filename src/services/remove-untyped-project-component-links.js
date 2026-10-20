'use strict';
/* global strapi */

/**
 * Startup script (issues/232): untyped copies of a project's component links.
 *
 * The project's beforeUpdate put the periodification / grant rows it had
 * resolved for the financials back into the update in place of their
 * `{ id, __pivot }` references, so every save linked each row once more with
 * `component_type` NULL. Populate reads every link of the field, so the API
 * returned each row once per save and the per-year figures moved by the
 * periodified amount again. (normalize-component-types leaves NULL alone.)
 *
 * On `projects_cmps`, for each NULL-typed link of a component field:
 *   - a typed twin (same project, row and field) exists, or the row is gone,
 *     or it repeats another NULL link: removed;
 *   - otherwise (the only link of a live row): typed with the field's UID.
 * Stored totals don't change (a periodification sums to 0, grant rows are not
 * in them), so no project is marked dirty. Idempotent: typed links are never
 * touched and a second run finds no NULL ones.
 */
const PROJECT = 'api::project.project';

async function removeUntypedProjectComponentLinks() {
  const { attributes } = strapi.db.metadata.get(PROJECT);
  const uidByField = {};
  let table = null;
  for (const [field, attribute] of Object.entries(strapi.contentType(PROJECT).attributes)) {
    if (attribute.type !== 'component') continue;
    uidByField[field] = attribute.component;
    table = table || (attributes[field] && attributes[field].joinTable && attributes[field].joinTable.name);
  }
  table = table || 'projects_cmps';

  const untyped = await strapi.db
    .connection(table)
    .whereNull('component_type')
    .select('id', 'entity_id', 'cmp_id', 'field');
  const candidates = untyped.filter((l) => uidByField[l.field]);
  if (!candidates.length) {
    strapi.log.info('[removeUntypedProjectComponentLinks] no untyped project component links');
    return { removed: [], typed: [] };
  }

  const typedKeys = new Set(
    (
      await strapi.db
        .connection(table)
        .whereNotNull('component_type')
        .whereIn(
          'entity_id',
          [...new Set(candidates.map((l) => l.entity_id))],
        )
        .select('entity_id', 'cmp_id', 'field')
    ).map((l) => `${l.entity_id}|${l.cmp_id}|${l.field}`),
  );

  const liveRows = {};
  for (const uid of new Set(candidates.map((l) => uidByField[l.field]))) {
    const ids = candidates.filter((l) => uidByField[l.field] === uid).map((l) => l.cmp_id);
    const { tableName } = strapi.db.metadata.get(uid);
    liveRows[uid] = new Set((await strapi.db.connection(tableName).whereIn('id', ids).select('id')).map((r) => r.id));
  }

  const removed = [];
  const typed = [];
  const kept = new Set();
  for (const link of candidates.sort((a, b) => a.id - b.id)) {
    const key = `${link.entity_id}|${link.cmp_id}|${link.field}`;
    const uid = uidByField[link.field];
    if (typedKeys.has(key) || kept.has(key) || !liveRows[uid].has(link.cmp_id)) {
      removed.push(link);
    } else {
      kept.add(key);
      typed.push(link);
    }
  }

  if (removed.length) {
    await strapi.db
      .connection(table)
      .whereIn(
        'id',
        removed.map((l) => l.id),
      )
      .del();
  }
  for (const link of typed) {
    await strapi.db
      .connection(table)
      .where('id', link.id)
      .update({ component_type: uidByField[link.field] });
  }

  const projects = [...new Set([...removed, ...typed].map((l) => l.entity_id))];
  strapi.log.info(
    `[removeUntypedProjectComponentLinks] removed ${removed.length} untyped link(s), typed ${typed.length}` +
      (projects.length ? ` (projects ${projects.map((id) => `#${id}`).join(', ')})` : ''),
  );
  return { removed, typed };
}

module.exports = { removeUntypedProjectComponentLinks };
