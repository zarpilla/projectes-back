'use strict';

/**
 * issues/328: a project's stored totals and `dirty` move from `projects` to
 * their own table, `project_totals` (see src/api/project/services/project-totals.js).
 *
 * Strapi runs this before it syncs the database with the content types, so:
 *   1. `project_totals` is created and filled from the columns of `projects`
 *      while they still hold the values;
 *   2. those columns are taken out of the schema Strapi recorded at its last
 *      sync (strapi_database_schema). They are no longer project attributes,
 *      and Strapi drops a removed attribute's column only if it recorded it:
 *      untracked, the columns stay. The backend still serving during a
 *      blue/green deploy selects them by name for a few minutes; dropped, every
 *      project read there would fail. A later release drops them explicitly.
 *
 * A database without projects yet (a new tenant) has nothing to copy; the
 * table is then created at boot (ensureProjectTotals). Runs once
 * (strapi_migrations), inside a transaction.
 */

const { TABLE, COLUMNS, createTable } = require('../../src/api/project/services/project-totals');

async function columnsOf(knex, table) {
  const [rows] = await knex.raw(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return new Set(rows.map((r) => r.c));
}

async function copyTotals(knex) {
  const present = await columnsOf(knex, 'projects');
  const columns = COLUMNS.filter((c) => present.has(c));
  if (!columns.length) return 0;
  const list = columns.map((c) => `\`${c}\``).join(', ');
  const [result] = await knex.raw(
    `INSERT INTO \`${TABLE}\` (project_id, ${list})
     SELECT id, ${list} FROM projects
     ON DUPLICATE KEY UPDATE ${columns.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`,
  );
  return result && result.affectedRows;
}

async function untrackColumns(knex) {
  if (!(await knex.schema.hasTable('strapi_database_schema'))) return 0;
  const rows = await knex('strapi_database_schema').select('id', 'schema');
  let removed = 0;
  for (const row of rows) {
    const schema = typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema;
    const projects = schema && Array.isArray(schema.tables) && schema.tables.find((t) => t.name === 'projects');
    if (!projects || !Array.isArray(projects.columns)) continue;
    const before = projects.columns.length;
    projects.columns = projects.columns.filter((c) => !COLUMNS.includes(c.name));
    removed += before - projects.columns.length;
    if (before !== projects.columns.length) {
      await knex('strapi_database_schema').where({ id: row.id }).update({ schema: JSON.stringify(schema) });
    }
  }
  return removed;
}

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable('projects'))) return;
    await createTable(knex);
    await copyTotals(knex);
    await untrackColumns(knex);
  },
  async down() {
    throw new Error('project-totals: no down migration (the old columns are still in projects)');
  },
  copyTotals,
  untrackColumns,
};
