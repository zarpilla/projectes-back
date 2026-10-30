'use strict';

/**
 * issues/329: drops the old total columns of `projects`.
 *
 * issues/328 moved a project's stored totals and `dirty` to `project_totals`
 * and left the old columns in `projects` (untracked by Strapi) because the
 * previous backend of a blue/green deploy still selected them. Every tenant
 * has run that release since, so nothing reads or writes them: they hold the
 * values of the day of that deploy.
 *
 * Only the columns still there are dropped: a tenant created after issues/328
 * never had them, and running it again does nothing.
 *
 * A rollback to an image from before issues/328 needs these columns back.
 */

const { COLUMNS } = require('../../src/api/project/services/project-totals');

async function oldColumns(knex) {
  const [rows] = await knex.raw(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['projects'],
  );
  const present = new Set(rows.map((r) => r.c));
  return COLUMNS.filter((c) => present.has(c));
}

async function dropOldColumns(knex) {
  if (!(await knex.schema.hasTable('projects'))) return [];
  const columns = await oldColumns(knex);
  if (!columns.length) return [];
  await knex.raw(`ALTER TABLE projects ${columns.map((c) => `DROP COLUMN \`${c}\``).join(', ')}`);
  return columns;
}

module.exports = {
  async up(knex) {
    await dropOldColumns(knex);
  },
  async down() {
    throw new Error('drop-old-project-total-columns: no down migration (the totals are in project_totals)');
  },
  dropOldColumns,
};
