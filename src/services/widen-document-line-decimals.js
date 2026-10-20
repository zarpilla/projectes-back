'use strict';
/* global strapi */

/**
 * Document lines (quotes, emitted and received invoices, tickets, diets,
 * received incomes / expenses) keep 4 decimals in the unit price, as budget
 * lines (issues/194, issues/270). Their `base` was DECIMAL(10,2): a quote line
 * 3 × 33,3333 showed 100,00 € before saving and 99,99 € after.
 *
 * Strapi never diffs a decimal's precision, so the columns are widened here;
 * idempotent, runs on every boot (runOnce: false). MySQL only.
 */
const { widenDecimalColumn, isMysql } = require('./widen-budget-line-decimals');

const DOCUMENT_LINE_SCALE = 4;

// Component tables (collectionName of src/components/invoice-line/*.json)
const TABLES = [
  'components_invoice_line_invoice_lines',
  'components_invoice_line_invoice_line_expenses',
  'components_invoice_line_ticket_lines',
];

async function widenDocumentLineDecimals() {
  if (!isMysql()) return;
  for (const tableName of TABLES) {
    await widenDecimalColumn(tableName, 'base', DOCUMENT_LINE_SCALE, 'widenDocumentLineDecimals');
  }
}

module.exports = { widenDocumentLineDecimals, DOCUMENT_LINE_SCALE };
