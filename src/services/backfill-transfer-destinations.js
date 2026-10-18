'use strict';
/* global strapi */

/**
 * Startup script (issues/156): transfers saved without a destination.
 *
 * The order lifecycles read the route without populating `transfer_pickup`, so
 * every transfer computed on v5 was saved with `transfer_pickup_destination`
 * null and Transferències showed «Destinació -». The destination is the
 * transfer pickup of the order's route, as the lifecycles set it now.
 *
 * Only transfers with no destination whose route has a transfer pickup are
 * touched. The link row is written straight to the join table: an update
 * through the entity layer would rerun the order lifecycles (prices,
 * discounts, collection orders).
 */
const ORDER = 'api::order.order';

async function backfillTransferDestinations() {
  const orders = await strapi.db.query(ORDER).findMany({
    where: { transfer: true },
    select: ['id'],
    populate: {
      transfer_pickup_destination: { select: ['id'] },
      route: { select: ['id'], populate: { transfer_pickup: { select: ['id'] } } },
    },
  });

  const fixes = orders
    .filter((o) => !o.transfer_pickup_destination && o.route && o.route.transfer_pickup)
    .map((o) => ({ order: o.id, pickup: o.route.transfer_pickup.id }));

  if (fixes.length) {
    const { joinTable } = strapi.db.metadata.get(ORDER).attributes.transfer_pickup_destination;
    await strapi.db.connection(joinTable.name).insert(
      fixes.map((f) => ({
        [joinTable.joinColumn.name]: f.order,
        [joinTable.inverseJoinColumn.name]: f.pickup,
      })),
    );
  }

  strapi.log.info(
    `[backfillTransferDestinations] destination set on ${fixes.length} transfers` +
      (fixes.length ? ` (${fixes.map((f) => `#${f.order}→${f.pickup}`).join(', ')})` : ''),
  );
  return fixes;
}

module.exports = { backfillTransferDestinations };
