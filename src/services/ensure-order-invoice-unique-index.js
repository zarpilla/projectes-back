'use strict';
/* global strapi */

/**
 * An order belongs to at most one emitted invoice (schema: oneToOne). The
 * link table the ETL build creates only carries the composite unique
 * (order_id, emitted_invoice_id) Strapi uses for relation bookkeeping, which
 * still allows the SAME order to be linked to two DIFFERENT invoices — the
 * mechanism behind the 2026-09-30 incident, where a duplicate
 * /api/orders/invoice run re-linked already invoiced orders to a second
 * draft. Enforce the real invariant with a single-column unique index on
 * order_id, created through this startup script so every tenant applies it
 * the same, versioned way (never hand-run DDL on a tenant database).
 *
 * Idempotent: verifies the index shape first and does nothing when correct,
 * so it is safe on every boot (runOnce: false).
 */
const { rawExecute } = require('./raw-sql');

const INDEX_NAME = 'orders_emitted_invoice_order_uq';

async function ensureOrderInvoiceUniqueIndex() {
  // Refuse to build the index over duplicate links: the CREATE would fail
  // mid-boot. Surface the offending order instead.
  const dupRows = await rawExecute(
    strapi,
    'SELECT order_id, COUNT(*) AS c FROM orders_emitted_invoice_lnk GROUP BY order_id HAVING c > 1 LIMIT 1',
    [],
  );
  if (Array.isArray(dupRows) && dupRows.length > 0) {
    throw new Error(
      `order ${dupRows[0].order_id} is linked to ${dupRows[0].c} emitted invoices; ` +
        'resolve the duplicates before the unique index can be created',
    );
  }

  // A single-column unique index whose only column is order_id.
  const existing = await rawExecute(
    strapi,
    `SELECT s.INDEX_NAME AS name
       FROM information_schema.STATISTICS s
       JOIN (
         SELECT INDEX_NAME, MAX(SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'orders_emitted_invoice_lnk'
            AND NON_UNIQUE = 0
            AND INDEX_NAME <> 'PRIMARY'
          GROUP BY INDEX_NAME
       ) x ON x.INDEX_NAME = s.INDEX_NAME
      WHERE s.TABLE_SCHEMA = DATABASE()
        AND s.TABLE_NAME = 'orders_emitted_invoice_lnk'
        AND s.COLUMN_NAME = 'order_id'
        AND x.cols = 1
      LIMIT 1`,
    [],
  );
  if (Array.isArray(existing) && existing.length > 0) {
    strapi.log.info(`[UNIQUE INDEX] ${existing[0].name} already enforces one invoice per order`);
    return;
  }

  await rawExecute(
    strapi,
    `CREATE UNIQUE INDEX ${INDEX_NAME} ON orders_emitted_invoice_lnk (order_id)`,
    [],
  );
  strapi.log.info(`[UNIQUE INDEX] created ${INDEX_NAME} on orders_emitted_invoice_lnk (order_id)`);
}

module.exports = { ensureOrderInvoiceUniqueIndex };
