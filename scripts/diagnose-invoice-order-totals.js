#!/usr/bin/env node
'use strict';

/**
 * READ ONLY (issues/233): lists the issued (state = 'real') emitted invoices
 * whose total_base differs from the sum of their linked orders' discounted
 * prices, (price − volume discount €) × (1 − (multidelivery % + pickup %) / 100)
 * rounded per order like the invoice line (final-price.js). The multidelivery
 * recompute used to reprice invoiced and delivered sibling orders, so an order
 * could stop matching the invoice line it was charged on.
 *
 * Each row is classified:
 *   - "cents (rounding)": |diff| ≤ 0,05 €;
 *   - "order changed after invoicing": as many lines as orders and the lines
 *     add up to total_base, so it is the orders that moved;
 *   - "lines differ from orders": extra, missing or hand-edited lines.
 *
 * Only SELECTs, on a read-only session, and without booting Strapi (whose
 * bootstrap would run pending startup scripts); it repairs nothing. Run
 * against one MySQL tenant (DATABASE_* env or .env, as Strapi; Node 20):
 *
 *   node scripts/diagnose-invoice-order-totals.js [--year 2026] [--tsv]
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

const SQL = `
WITH ord AS (
  SELECT l.emitted_invoice_id AS invoice_id,
         COUNT(*) AS n_orders,
         SUM(ROUND((COALESCE(o.price,0) - COALESCE(o.volume_discount,0))
                   * (1 - (COALESCE(o.multidelivery_discount,0) + COALESCE(o.contact_pickup_discount,0)) / 100), 2)) AS orders_base,
         SUM(o.multidelivery_discount > 0) AS n_with_multidelivery,
         SUM(o.status <> 'invoiced') AS n_not_invoiced_status,
         GROUP_CONCAT(o.id ORDER BY o.id) AS order_ids
  FROM orders_emitted_invoice_lnk l
  JOIN orders o ON o.id = l.order_id
  GROUP BY l.emitted_invoice_id
),
lin AS (
  SELECT c.entity_id AS invoice_id, COUNT(*) AS n_lines,
         SUM(ROUND(li.base * COALESCE(li.quantity,1) * (1 - COALESCE(li.discount,0) / 100), 2)) AS lines_base
  FROM emitted_invoices_cmps c
  JOIN components_invoice_line_invoice_lines li ON li.id = c.cmp_id
  WHERE c.component_type = 'invoice-line.invoice-line' AND c.field = 'lines'
  GROUP BY c.entity_id
)
SELECT i.id, i.code, i.emitted, i.total_base, ord.orders_base,
       ROUND(i.total_base - ord.orders_base, 2) AS diff,
       lin.lines_base, ord.n_orders, lin.n_lines, ord.n_with_multidelivery, ord.n_not_invoiced_status,
       CASE WHEN ABS(i.total_base - ord.orders_base) <= 0.05 THEN 'cents (rounding)'
            WHEN COALESCE(lin.n_lines,0) = ord.n_orders AND ABS(COALESCE(lin.lines_base,0) - i.total_base) <= 0.05
            THEN 'order changed after invoicing'
            ELSE 'lines differ from orders (extra/missing/edited lines)' END AS kind,
       ord.order_ids
FROM emitted_invoices i
JOIN ord ON ord.invoice_id = i.id
LEFT JOIN lin ON lin.invoice_id = i.id
WHERE i.state = 'real'
  AND ABS(i.total_base - ord.orders_base) >= 0.015
ORDER BY i.emitted, i.id
`;

function parseArgs(argv) {
  const args = { year: null, tsv: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--year') args.year = String(argv[(i += 1)]);
    else if (argv[i] === '--tsv') args.tsv = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 3306),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    dateStrings: true,
  });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    const [rows] = await conn.query(SQL);
    const list = rows.filter((r) => !args.year || String(r.emitted).startsWith(args.year));
    if (args.tsv) {
      const cols = Object.keys(list[0] || {});
      console.log(cols.join('\t'));
      for (const r of list) console.log(cols.map((c) => r[c]).join('\t'));
    } else {
      for (const r of list) {
        console.log(
          `#${r.id} ${r.code} ${r.emitted}  total_base ${r.total_base}  orders ${r.orders_base}  diff ${r.diff}  (${r.kind}; ${r.n_orders} orders, ${r.n_lines} lines)`,
        );
      }
    }
    const byKind = {};
    for (const r of list) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    console.error(`\n${process.env.DATABASE_NAME}: ${list.length} issued invoices differ`, byKind);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
