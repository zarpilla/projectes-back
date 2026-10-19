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

async function widenBudgetLineDecimals() {
  const client = (strapi.db.dialect && strapi.db.dialect.client) || '';
  if (client !== 'mysql') return;

  for (const uid of UIDS) {
    const { tableName } = strapi.db.metadata.get(uid);
    for (const column of COLUMNS) {
      const rows = await rawExecute(
        strapi,
        `SELECT NUMERIC_SCALE AS scale FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [tableName, column],
      );
      if (!Array.isArray(rows) || !rows.length || Number(rows[0].scale) >= BUDGET_LINE_SCALE) continue;
      await rawExecute(
        strapi,
        `ALTER TABLE \`${tableName}\` MODIFY \`${column}\` DECIMAL(14,${BUDGET_LINE_SCALE}) NULL`,
        [],
      );
      strapi.log.info(`[widenBudgetLineDecimals] ${tableName}.${column} → DECIMAL(14,${BUDGET_LINE_SCALE})`);
    }
  }
}

module.exports = { widenBudgetLineDecimals };
