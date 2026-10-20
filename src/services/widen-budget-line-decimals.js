'use strict';
/* global strapi */

/**
 * Budget lines keep 4 decimals in quantity and unit price (issues/194). Strapi
 * creates every `decimal` attribute as DECIMAL(10,2) and its schema sync never
 * compares precision, so the columns are widened here to DECIMAL(14,4): same
 * 10 integer digits, 4 decimals. A typed 0,0357 was stored as 0,04.
 *
 * Idempotent: only columns with fewer than 4 decimals are altered, so it runs
 * on every boot (runOnce: false) and a tenant rebuilt by the ETL or a new
 * database gets them back. MySQL only (every tenant); other clients are left
 * as they are.
 */
const { rawExecute } = require('./raw-sql');
const { BUDGET_LINE_SCALE } = require('./budget-line');

const UIDS = ['api::phase-income.phase-income', 'api::phase-expense.phase-expense'];
const COLUMNS = ['quantity', 'amount'];

/**
 * Widens `column` of `tableName` to DECIMAL(14,scale) when it keeps fewer
 * decimals; a missing table or column is skipped. Returns whether it altered it.
 */
async function widenDecimalColumn(tableName, column, scale, label) {
  const rows = await rawExecute(
    strapi,
    `SELECT NUMERIC_SCALE AS scale FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, column],
  );
  if (!Array.isArray(rows) || !rows.length || Number(rows[0].scale) >= scale) return false;
  await rawExecute(strapi, `ALTER TABLE \`${tableName}\` MODIFY \`${column}\` DECIMAL(14,${scale}) NULL`, []);
  strapi.log.info(`[${label}] ${tableName}.${column} → DECIMAL(14,${scale})`);
  return true;
}

const isMysql = () => ((strapi.db.dialect && strapi.db.dialect.client) || '') === 'mysql';

async function widenBudgetLineDecimals() {
  if (!isMysql()) return;

  for (const uid of UIDS) {
    const { tableName } = strapi.db.metadata.get(uid);
    for (const column of COLUMNS) {
      await widenDecimalColumn(tableName, column, BUDGET_LINE_SCALE, 'widenBudgetLineDecimals');
    }
  }
}

module.exports = { widenBudgetLineDecimals, widenDecimalColumn, isMysql };
