'use strict';
/* global strapi */

/**
 * The invoice, order and document forms read one record's history from
 * document_change_logs: WHERE entity = ? AND entity_id = ? ORDER BY
 * created_at DESC (issues/161). Strapi creates no index for it, and the table
 * gets a row on every save of every tracked record, so without one each
 * history read scans the whole table.
 *
 * Idempotent: does nothing when the index exists, so it runs on every boot
 * (runOnce: false) and a tenant rebuilt by the ETL gets it back.
 */
const { rawExecute } = require('./raw-sql');

const TABLE = 'document_change_logs';
const INDEX_NAME = 'document_change_logs_entity_idx';
const COLUMNS = '(entity, entity_id, created_at)';

async function ensureChangeLogIndex() {
  const client = (strapi.db.dialect && strapi.db.dialect.client) || '';

  if (client !== 'mysql') {
    // postgres and sqlite know IF NOT EXISTS
    await rawExecute(strapi, `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON ${TABLE} ${COLUMNS}`, []);
    return;
  }

  const existing = await rawExecute(
    strapi,
    `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [TABLE, INDEX_NAME],
  );
  if (Array.isArray(existing) && existing.length > 0) return;

  await rawExecute(strapi, `CREATE INDEX ${INDEX_NAME} ON ${TABLE} ${COLUMNS}`, []);
  strapi.log.info(`[INDEX] created ${INDEX_NAME} on ${TABLE} ${COLUMNS}`);
}

module.exports = { ensureChangeLogIndex, INDEX_NAME };
