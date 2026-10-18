'use strict';
/* global strapi */

/**
 * Startup script (issues/135): `is_mother` without the trashed children.
 *
 * Until the fix a trashed child still made its project a mother (and added up
 * into its totals, which are computed on read and need no repair). A project
 * whose children are all in the trash kept `is_mother` and stayed in
 * «Projectes mare».
 *
 * Sets `is_mother` from the live (not trashed) children of every project.
 * Written straight to the table: through the entity layer each row would run
 * the totals lifecycle. Idempotent: only rows whose flag is wrong are touched.
 */
const PROJECT = 'api::project.project';

async function recountMotherFlags() {
  const projects = await strapi.db.query(PROJECT).findMany({
    select: ['id', 'is_mother', 'trashed'],
    populate: { mother: { select: ['id'] } },
  });

  const mothers = new Set();
  for (const p of projects) {
    if (p.trashed === true || !p.mother || p.mother.id === p.id) continue;
    mothers.add(p.mother.id);
  }

  const on = projects.filter((p) => mothers.has(p.id) && p.is_mother !== true).map((p) => p.id);
  const off = projects.filter((p) => !mothers.has(p.id) && p.is_mother === true).map((p) => p.id);

  const { tableName } = strapi.db.metadata.get(PROJECT);
  if (on.length) await strapi.db.connection(tableName).whereIn('id', on).update({ is_mother: true });
  if (off.length) await strapi.db.connection(tableName).whereIn('id', off).update({ is_mother: false });

  strapi.log.info(
    `[recountMotherFlags] is_mother set on ${on.length} projects${on.length ? ` (${on.join(', ')})` : ''}, ` +
      `cleared on ${off.length}${off.length ? ` (${off.join(', ')})` : ''}`,
  );
  return { on, off };
}

module.exports = { recountMotherFlags };
