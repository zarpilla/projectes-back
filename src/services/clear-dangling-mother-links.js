'use strict';
/* global strapi */

/**
 * Startup script (issues/206): mother links to projects that don't exist.
 *
 * The ETL copies v3's `mother` column with the foreign keys off, so a project
 * whose v3 mother had been deleted came over pointing at a missing row (on
 * resilience, 388 -> 731). v5 itself can't leave one behind: the link table's
 * foreign keys cascade on delete, so deleting a mother drops its children's
 * links. The dangling row populates as no mother anyway, but it claims a
 * relation that isn't there.
 *
 * Removes the link rows whose child or mother is missing. Straight on the link
 * table; idempotent: valid links are never touched.
 */
const PROJECT = 'api::project.project';

async function clearDanglingMotherLinks() {
  const { tableName, attributes } = strapi.db.metadata.get(PROJECT);
  const { joinTable } = attributes.mother;
  const childCol = joinTable.joinColumn.name;
  const motherCol = joinTable.inverseJoinColumn.name;

  const ids = new Set((await strapi.db.connection(tableName).select('id')).map((r) => r.id));
  const links = await strapi.db.connection(joinTable.name).select('id', childCol, motherCol);
  const dangling = links.filter((l) => !ids.has(l[childCol]) || !ids.has(l[motherCol]));

  if (dangling.length) {
    await strapi.db
      .connection(joinTable.name)
      .whereIn(
        'id',
        dangling.map((l) => l.id),
      )
      .del();
  }

  strapi.log.info(
    `[clearDanglingMotherLinks] removed ${dangling.length} mother links to missing projects` +
      (dangling.length ? ` (${dangling.map((l) => `#${l[childCol]} -> #${l[motherCol]}`).join(', ')})` : ''),
  );
  return dangling;
}

module.exports = { clearDanglingMotherLinks };
