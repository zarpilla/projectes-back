'use strict';

/* global strapi */

/**
 * Startup script: fill the empty order columns of the relations' link tables
 * (issues/334).
 *
 * Strapi lists the items of a relation (a document's projects, …) by the link
 * table's order column (`project_ord` in emitted_invoices_projects_lnk), with
 * nothing to break a tie. Most links came from v3 with that column empty
 * (NULL): MySQL then gives them in any order, which changes with the query
 * plan, so the lists that show a document's first project (Ingressos,
 * Despeses and their exports) showed one project now and another after a
 * reload. Strapi's own renumbering, when a relation changes, sorts by that
 * same column and kept the ties.
 *
 * In each group (the projects of one document) with an empty order, every
 * link gets one: the empty ones first, as MySQL sorts them today, in the order
 * they were made (their `id`, the order the user saw in v3), then those
 * already ordered, in their order. Groups with every order set are left alone,
 * so a rerun changes nothing.
 */

/**
 * The order columns of `metadata` (Strapi's db.metadata): for each, the link
 * table, the column and the column that groups it (the owner's id). Relations
 * through a link table only: not the components' (`_cmps`, grouped by field
 * too) nor the polymorphic ones.
 */
function orderColumns(metadata) {
  const found = new Map();
  for (const meta of metadata.values()) {
    for (const attribute of Object.values(meta.attributes || {})) {
      if (attribute.type !== 'relation' || String(attribute.relation || '').startsWith('morph')) continue;
      const joinTable = attribute.joinTable;
      if (!joinTable || !joinTable.name || joinTable.on) continue;
      const add = (column, groupBy) => {
        if (!column || !groupBy) return;
        found.set(`${joinTable.name}.${column}`, { table: joinTable.name, column, groupBy });
      };
      add(joinTable.orderColumnName, joinTable.joinColumn && joinTable.joinColumn.name);
      add(joinTable.inverseOrderColumnName, joinTable.inverseJoinColumn && joinTable.inverseJoinColumn.name);
    }
  }
  return [...found.values()].sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

async function existingColumns(knex) {
  const [rows] = await knex.raw(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
  );
  return new Set(rows.map((r) => `${r.t}.${r.c}`));
}

/**
 * Fills the empty orders of `columns` (from orderColumns) in their groups.
 * Tables or columns the database doesn't have yet are skipped. Returns the
 * rows changed per `table.column`, those with changes only.
 */
async function fillRelationOrder(knex, columns) {
  const present = await existingColumns(knex);
  const changed = {};
  for (const { table, column, groupBy } of columns) {
    if (![column, groupBy, 'id'].every((c) => present.has(`${table}.${c}`))) continue;
    const [result] = await knex.raw(
      `UPDATE ?? AS a JOIN (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY ?? ORDER BY ?? ASC, id ASC) AS n
         FROM ??
         WHERE ?? IN (SELECT DISTINCT ?? FROM ?? WHERE ?? IS NULL AND ?? IS NOT NULL)
       ) AS b ON b.id = a.id
       SET a.?? = b.n`,
      [table, groupBy, column, table, groupBy, groupBy, table, column, groupBy, column],
    );
    if (result.affectedRows) changed[`${table}.${column}`] = result.affectedRows;
  }
  return changed;
}

/** The startup script: every order column of the content types. */
async function fillEmptyRelationOrder() {
  const changed = await fillRelationOrder(strapi.db.connection, orderColumns(strapi.db.metadata));
  const total = Object.values(changed).reduce((sum, n) => sum + n, 0);
  strapi.log.info(`[fillEmptyRelationOrder] ${total} link rows ordered${total ? `: ${JSON.stringify(changed)}` : ''}`);
  return changed;
}

module.exports = { orderColumns, fillRelationOrder, fillEmptyRelationOrder };
