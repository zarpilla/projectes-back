'use strict';

/**
 * The tables of the current database and their foreign keys, for the change
 * tracker (issues/307): table names to find in statements, foreign keys to
 * follow the cascades of a delete.
 * @param {import('knex').Knex} knex
 */
async function loadSchema(knex) {
  const [tables] = await knex.raw(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const [keys] = await knex.raw(
    `SELECT TABLE_NAME AS \`table\`, REFERENCED_TABLE_NAME AS referencedTable, DELETE_RULE AS deleteRule, UPDATE_RULE AS updateRule
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()`,
  );
  if (!tables.length) throw new Error('read-cache: the database has no tables');
  return {
    tables: tables.map((t) => t.name),
    foreignKeys: keys.map((k) => ({ ...k })),
  };
}

module.exports = { loadSchema };
