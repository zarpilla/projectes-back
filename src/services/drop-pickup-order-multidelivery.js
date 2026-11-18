'use strict';
/* global strapi */

/**
 * Startup script (issues/438): a pickup order (-R) is not a delivery, so it
 * never has a multidelivery discount and never makes one for the orders of the
 * same point and day. The hooks gave it anyway: two -R of a farm on one day
 * both got 20 %, and on top of the farm's pickup discount (99,9 %) the line
 * came to −119,9 % (Diligència 25862, 25867). An order whose only «other
 * order» that day was a -R got 20 % too.
 *
 * Only open orders are repriced: not invoiced nor cancelled, and on no
 * invoice. Delivered ones too, since they are billed at the end of the month.
 * An invoiced order keeps the amount it was invoiced with. Nothing gets a
 * discount here, it is only taken away. Written straight to the table (the
 * order lifecycles would reprice the siblings again) and recorded in each
 * order's history.
 *
 * Idempotent: a second run finds nothing to change.
 */
const changeLog = require('./change-log');
const { toQueryDay } = require('./date-fields');

const ORDER = 'api::order.order';

const isOpen = (o) => !['invoiced', 'cancelled'].includes(o.status) && !o.emitted_invoice;

async function hasDeliverySibling(order) {
  const contactId = order.contact && order.contact.id;
  if (!contactId || !order.estimated_delivery_date) return false;
  const siblings = await strapi.db.query(ORDER).findMany({
    where: {
      contact: contactId,
      estimated_delivery_date: toQueryDay(order.estimated_delivery_date),
      id: { $ne: order.id },
      status: { $ne: 'cancelled' },
    },
    select: ['id', 'is_collection_order'],
  });
  return siblings.some((s) => !s.is_collection_order);
}

async function dropPickupOrderMultidelivery() {
  const discounted = await strapi.db.query(ORDER).findMany({
    where: { multidelivery_discount: { $gt: 0 }, status: { $notIn: ['invoiced', 'cancelled'] } },
    select: ['id', 'status', 'multidelivery_discount', 'is_collection_order', 'estimated_delivery_date'],
    populate: { contact: { select: ['id'] }, emitted_invoice: { select: ['id'] } },
  });

  const wrong = [];
  for (const order of discounted.filter(isOpen)) {
    if (order.is_collection_order || !(await hasDeliverySibling(order))) wrong.push(order);
  }
  if (!wrong.length) {
    strapi.log.info('[dropPickupOrderMultidelivery] no open order to fix');
    return [];
  }

  const { tableName } = strapi.db.metadata.get(ORDER);
  await strapi.db
    .connection(tableName)
    .whereIn(
      'id',
      wrong.map((o) => o.id),
    )
    .update({ multidelivery_discount: 0 });

  await changeLog.logChanges(
    ORDER,
    wrong.map((o) => ({
      row: { id: o.id },
      changes: [{ field: 'multidelivery_discount', from: o.multidelivery_discount, to: 0 }],
    })),
  );

  strapi.log.info(
    `[dropPickupOrderMultidelivery] ${wrong.length} open orders lose their multidelivery discount: ` +
      wrong.map((o) => `#${o.id}${o.is_collection_order ? ' (-R)' : ''} ${o.multidelivery_discount}→0`).join(', '),
  );
  return wrong.map((o) => o.id);
}

module.exports = { dropPickupOrderMultidelivery };
