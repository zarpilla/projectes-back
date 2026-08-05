'use strict';

/**
 * Safe raw-SQL helper for Strapi v5.
 *
 * ALL raw SQL in this project must go through this module. It enforces parameter
 * binding, closing the SQL-injection hole that existed in the v3
 * `emitted-invoice.payEntity` (Risk R11), where user-supplied `vat_paid_date` and
 * document ids were string-interpolated directly into UPDATE statements.
 *
 * v5 access: `strapi.db.connection` (Knex). Prefer Document Service / db.query
 * everywhere else; only use raw SQL when you must bypass lifecycles (bulk status
 * updates, stored-totals refresh — see docs/DATA_ACCESS_CONVENTIONS.md §3).
 *
 * Usage:
 *   const { rawUpdate } = require('../../services/raw-sql');
 *   await rawUpdate(strapi,
 *     'UPDATE emitted_invoices SET vat_paid_date = ?, deductible_vat_pct = ? WHERE id = ?',
 *     [vatPaidDate, pct, id],
 *   );
 *
 * The bindings array is ALWAYS required. The helper throws if a query is passed
 * without bindings or if a bindings value is undefined (the most common cause of
 * silent data corruption in parameterized queries).
 */

function ensureBindings(query, bindings) {
  if (!Array.isArray(bindings)) {
    throw new Error('raw-sql: bindings must be an array (even if empty). Query: ' + query.slice(0, 80));
  }
  // Count placeholders (?), excluding those inside single-quoted string literals.
  // For our controlled internal SQL this simple check is sufficient.
  const placeholderCount = (query.match(/\?/g) || []).length;
  if (placeholderCount !== bindings.length) {
    throw new Error(
      `raw-sql: placeholder count (${placeholderCount}) != bindings length (${bindings.length}). Query: ${query.slice(0, 80)}`,
    );
  }
  for (let i = 0; i < bindings.length; i++) {
    if (bindings[i] === undefined) {
      throw new Error(`raw-sql: binding #${i} is undefined. Query: ${query.slice(0, 80)}`);
    }
  }
}

/**
 * Execute a raw parameterized query that does NOT return rows (UPDATE/DELETE/INSERT).
 * @param {object} strapi - the Strapi instance
 * @param {string} query - SQL with ? placeholders
 * @param {Array} bindings - values for the placeholders
 * @returns {Promise<number>} number of affected rows (Knex raw response[1]?.affectedRows or [0])
 */
async function rawExecute(strapi, query, bindings) {
  ensureBindings(query, bindings);
  const res = await strapi.db.connection.raw(query, bindings);
  // Knex/mysql2 returns [rows, fields] for SELECT-like and { fieldCount, affectedRows, ... } for others.
  // Normalize to a best-effort affectedRows number.
  if (Array.isArray(res) && res.length > 1 && typeof res[1] === 'object' && res[1] !== null) {
    return res[1].affectedRows ?? res[0];
  }
  if (res && typeof res === 'object' && 'affectedRows' in res) {
    return res.affectedRows;
  }
  return Array.isArray(res) ? res[0] : res;
}

/**
 * Bulk update via a knex query builder (skips Strapi lifecycles — intentional).
 * Equivalent to v3 `strapi.connections.default('table').where(...).update(...)`.
 * @param {object} strapi
 * @param {string} table - DB table name (e.g. 'projects')
 * @param {object} where - where clause object
 * @param {object} data - column -> value to set
 * @returns {Promise<number>} affected rows
 */
async function bulkUpdate(strapi, table, where, data) {
  return strapi.db.connection(table).where(where).update(data);
}

module.exports = {
  rawExecute,
  bulkUpdate,
  _ensureBindings: ensureBindings, // exported for unit testing
};
