#!/usr/bin/env node
'use strict';

/**
 * READ ONLY (issues/292): lists the farm-collection orders (-R) whose delivery
 * type disagrees with what they collect: `refrigerated` (any of its orders is
 * refrigerated) set with a normal delivery type, or the other way round. The
 * rate of a -R was chosen by its own delivery type, copied from its newest
 * order only, so these were charged the wrong rate.
 *
 * For each one it prints the stored rate and price and the ones the fixed
 * recompute gives (delivery type matching `refrigerated`: the newest of its
 * orders' that matches, else the first delivery type that does; the rate
 * picked as updateCollectionOrderAggregates does), before and after the
 * pickup discount, and whether the recompute will touch it:
 *   - "will change on its next recompute": open and on no invoice;
 *   - "frozen (delivered / on an invoice)": the recompute keeps its type;
 *   - "frozen (invoiced/cancelled)": never recomputed (no new price for a
 *     cancelled one, whose price was zeroed).
 *
 * Only SELECTs, on a read-only session, and without booting Strapi; it repairs
 * nothing. Run against one MySQL tenant (DATABASE_* env or .env; Node 20):
 *
 *   node scripts/diagnose-collection-order-rates.js [--tsv]
 */

const path = require('path');
const {
  calculatePriceFromRouteRate,
  pickCollectionOrderRouteRate,
} = require('../src/api/order/services/route-price');

const ROOT = path.join(__dirname, '..');

const COLLECTION_ORDERS_SQL = `
SELECT o.id, o.status, o.refrigerated, o.kilograms, o.price, o.contact_pickup_discount,
       r.route_id, dt.delivery_type_id, d.refrigerated AS type_refrigerated, rr.route_rate_id,
       ei.emitted_invoice_id
FROM orders o
LEFT JOIN orders_route_lnk r ON r.order_id = o.id
LEFT JOIN orders_delivery_type_lnk dt ON dt.order_id = o.id
LEFT JOIN delivery_types d ON d.id = dt.delivery_type_id
LEFT JOIN orders_route_rate_lnk rr ON rr.order_id = o.id
LEFT JOIN orders_emitted_invoice_lnk ei ON ei.order_id = o.id
WHERE o.is_collection_order = 1
  AND (COALESCE(o.refrigerated, 0) <> 0) <> (COALESCE(d.refrigerated, 0) <> 0)
ORDER BY o.id`;

const CHILDREN_SQL = `
SELECT l.inv_order_id AS collection_order_id, o.id, dt.delivery_type_id, d.refrigerated
FROM orders_collection_order_lnk l
JOIN orders o ON o.id = l.order_id
LEFT JOIN orders_delivery_type_lnk dt ON dt.order_id = o.id
LEFT JOIN delivery_types d ON d.id = dt.delivery_type_id
WHERE o.status NOT IN ('cancelled', 'invoiced')`;

const round2 = (n) => Math.round(n * 100) / 100;
const cold = (v) => Boolean(Number(v));

async function loadRates(conn) {
  const [rates] = await conn.query('SELECT * FROM route_rates');
  const [routes] = await conn.query('SELECT route_rate_id, route_id FROM route_rates_routes_lnk');
  const [pickups] = await conn.query(
    'SELECT l.route_rate_id, p.id, p.pickup FROM route_rates_pickup_lnk l JOIN pickups p ON p.id = l.pickup_id',
  );
  const [types] = await conn.query('SELECT route_rate_id, delivery_type_id FROM route_rates_delivery_type_lnk');
  // columns are snake_case (less_15, from_10_to_20, ratev_2): back to the
  // attribute names calculatePriceFromRouteRate reads
  const attributes = (row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      const name = key.replace(/_(\d)/g, '$1').replace(/(\d)_/g, '$1');
      out[name] = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    }
    return out;
  };
  return rates.map((row) => attributes(row)).map((r) => ({
    ...r,
    ratev2: cold(r.ratev2),
    routes: routes.filter((x) => x.route_rate_id === r.id).map((x) => ({ id: x.route_id })),
    pickup: (() => {
      const p = pickups.find((x) => x.route_rate_id === r.id);
      return p ? { id: p.id, pickup: cold(p.pickup) } : null;
    })(),
    delivery_type: (() => {
      const t = types.find((x) => x.route_rate_id === r.id);
      return t ? { id: t.delivery_type_id } : null;
    })(),
  }));
}

async function main() {
  const tsv = process.argv.includes('--tsv');
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
    const [orders] = await conn.query(COLLECTION_ORDERS_SQL);
    const [children] = await conn.query(CHILDREN_SQL);
    const [deliveryTypes] = await conn.query('SELECT id, name, refrigerated FROM delivery_types ORDER BY id');
    const rates = await loadRates(conn);
    const typeName = (id) => (deliveryTypes.find((t) => t.id === id) || {}).name || id;

    const rows = orders.map((o) => {
      const wantCold = cold(o.refrigerated);
      const child = children
        .filter((c) => c.collection_order_id === o.id && c.delivery_type_id && cold(c.refrigerated) === wantCold)
        .sort((a, b) => b.id - a.id)[0];
      const fallback = deliveryTypes.find((t) => cold(t.refrigerated) === wantCold);
      const newType = child ? child.delivery_type_id : fallback ? fallback.id : o.delivery_type_id;
      const rate = pickCollectionOrderRouteRate(rates, { routeId: o.route_id, deliveryTypeId: newType });
      const kg = Number(o.kilograms) || 0;
      // a cancelled -R is never priced again (it was zeroed when cancelled)
      const newPrice =
        rate && o.status !== 'cancelled' ? round2(calculatePriceFromRouteRate(rate, kg, 0)) : null;
      const discount = Number(o.contact_pickup_discount) || 0;
      const net = (p) => (p === null || p === undefined ? null : round2(Number(p) * (1 - discount / 100)));
      const kind = ['invoiced', 'cancelled'].includes(o.status)
        ? 'frozen (invoiced/cancelled)'
        : o.status === 'delivered' || o.emitted_invoice_id
          ? 'frozen (delivered / on an invoice)'
          : 'will change on its next recompute';
      return {
        id: o.id,
        status: o.status,
        invoice: o.emitted_invoice_id || '',
        refrigerated: wantCold ? 1 : 0,
        kg,
        old_type: typeName(o.delivery_type_id),
        new_type: typeName(newType),
        old_rate: o.route_rate_id,
        new_rate: rate ? rate.id : null,
        old_price: o.price === null ? null : Number(o.price),
        new_price: newPrice,
        pickup_discount: discount,
        old_net: net(o.price),
        new_net: net(newPrice),
        kind,
      };
    });

    if (tsv) {
      const cols = Object.keys(rows[0] || {});
      console.log(cols.join('\t'));
      for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'));
    } else {
      for (const r of rows) {
        console.log(
          `#${r.id} ${r.status}${r.invoice ? ` (invoice ${r.invoice})` : ''} refrigerated=${r.refrigerated} ${r.kg} kg: ` +
            `${r.old_type} rate ${r.old_rate} ${r.old_price} € -> ${r.new_type} rate ${r.new_rate} ${r.new_price} € ` +
            `(after ${r.pickup_discount} % pickup discount ${r.old_net} -> ${r.new_net} €) — ${r.kind}`,
        );
      }
    }
    const byKind = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    console.error(
      `\n${process.env.DATABASE_NAME}: ${rows.length} collection orders with a mismatched delivery type ` +
        `(${rows.filter((r) => r.refrigerated).length} refrigerated with a normal type, ` +
        `${rows.filter((r) => !r.refrigerated).length} the other way round)`,
      byKind,
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
