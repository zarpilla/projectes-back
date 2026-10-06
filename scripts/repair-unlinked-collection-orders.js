#!/usr/bin/env node
'use strict';

/**
 * Relink orders that lost their collection order (diligencia, 2026-10-06).
 *
 * Reusing a collection order wrote `collection_orders: [id]`, which v5 treats
 * as the whole relation: each order grouped into an existing collection order
 * unlinked every order grouped before it. Since the grouping fix of 2026-09-28
 * most orders sent to a collection point ended up with no collection order —
 * 24875 picked up 24886 only, while 24874 and 24876–24883 belong to it too.
 *
 * For each order with a collection point, pickup route and pickup date but no
 * collection order, this finds the collection order the grouping would have
 * used (same owner, collection point as contact, route and pickup date), links
 * the order to it and recomputes the collection order's units, kilograms and
 * price.
 *
 * Left alone:
 *   - orders and collection orders that are cancelled or invoiced;
 *   - delivered collection orders, unless --include-delivered;
 *   - orders with no matching collection order, or more than one.
 *
 * Run against one tenant (DATABASE_* env, as Strapi; Node 20):
 *
 *   node scripts/repair-unlinked-collection-orders.js --since 2026-09-28
 *       [--include-delivered] [--apply]
 *
 * Without --apply it only prints what it would do.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLOSED = ['cancelled', 'invoiced'];

function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const since = value('--since');
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('Usage: repair-unlinked-collection-orders.js --since YYYY-MM-DD [--include-delivered] [--apply]');
    process.exit(1);
  }
  return {
    since,
    apply: argv.includes('--apply'),
    includeDelivered: argv.includes('--include-delivered'),
  };
}

const findUnlinkedOrders = (knex, since) =>
  knex('orders as o')
    .join('orders_collection_point_lnk as cp', 'cp.order_id', 'o.id')
    .join('orders_collection_pickup_route_lnk as cpr', 'cpr.order_id', 'o.id')
    .join('orders_owner_lnk as ow', 'ow.order_id', 'o.id')
    .leftJoin('orders_collection_order_lnk as l', 'l.order_id', 'o.id')
    .whereNull('l.id')
    .where((q) => q.whereNull('o.is_collection_order').orWhere('o.is_collection_order', false))
    .whereNotIn('o.status', CLOSED)
    .where('o.collection_pickup_date', '>=', since)
    .select(
      'o.id',
      'o.status',
      knex.raw('DATE_FORMAT(o.collection_pickup_date, "%Y-%m-%d") as pickup_date'),
      'ow.user_id as owner',
      'cp.contact_id as collection_point',
      'cpr.route_id as route',
    )
    .orderBy('o.id');

const findCollectionOrders = (knex, order) =>
  knex('orders as c')
    .join('orders_owner_lnk as ow', 'ow.order_id', 'c.id')
    .join('orders_contact_lnk as ct', 'ct.order_id', 'c.id')
    .join('orders_route_lnk as r', 'r.order_id', 'c.id')
    .where('c.is_collection_order', true)
    .where('ow.user_id', order.owner)
    .where('ct.contact_id', order.collection_point)
    .where('r.route_id', order.route)
    .whereRaw('DATE(c.collection_pickup_date) = ?', [order.pickup_date])
    .whereNotIn('c.status', CLOSED)
    .select('c.id', 'c.status')
    .orderBy('c.id');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.chdir(ROOT);
  const { createStrapi } = require('@strapi/strapi');
  const app = await createStrapi({ appDir: ROOT, distDir: ROOT }).load();
  app.log.level = 'warn';

  try {
    const knex = app.db.connection;
    const { updateCollectionOrderAggregates } =
      require('../src/api/order/content-types/order/lifecycles').collectionOrderHelpers;

    const plan = new Map(); // collection order id -> order ids
    const skipped = [];
    for (const order of await findUnlinkedOrders(knex, args.since)) {
      const label = `#${order.id} (${order.status}, ${order.pickup_date}, owner ${order.owner}, route ${order.route})`;
      const candidates = (await findCollectionOrders(knex, order)).filter(
        (c) => args.includeDelivered || c.status !== 'delivered',
      );
      if (candidates.length !== 1) {
        skipped.push(`${label}: ${candidates.length ? `ambiguous ${candidates.map((c) => c.id).join(', ')}` : 'no open collection order'}`);
        continue;
      }
      const target = candidates[0];
      if (!plan.has(target.id)) plan.set(target.id, { status: target.status, orders: [] });
      plan.get(target.id).orders.push(order.id);
    }

    for (const [coId, { status, orders }] of plan) {
      console.log(`collection order #${coId} (${status}) <- ${orders.map((id) => `#${id}`).join(', ')}`);
    }
    for (const line of skipped) console.log(`skipped ${line}`);

    if (!args.apply) {
      console.log(`\nDry run: ${plan.size} collection orders, ${skipped.length} skipped. Re-run with --apply to write.`);
      return;
    }

    const orderQuery = app.db.query('api::order.order');
    for (const [coId, { orders }] of plan) {
      const before = await knex('orders').where({ id: coId }).first('units', 'kilograms', 'price');
      await orderQuery.update({
        where: { id: coId },
        data: { collection_orders: { connect: orders }, _internal: true },
      });
      await updateCollectionOrderAggregates(coId);
      const after = await knex('orders').where({ id: coId }).first('units', 'kilograms', 'price');
      console.log(
        `#${coId}: linked ${orders.length}; units ${before.units} -> ${after.units}, ` +
          `kg ${before.kilograms} -> ${after.kilograms}, price ${before.price} -> ${after.price}`,
      );
    }
  } finally {
    await app.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
