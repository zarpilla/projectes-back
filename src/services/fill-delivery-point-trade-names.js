'use strict';
/* global strapi */

/**
 * Startup script (issues/215): delivery points without «Nom comercial».
 *
 * The trade name is now required on delivery points (contacts with an owner):
 * the order form lists the points by it. The points saved before without one
 * get their name as trade name. Contacts without an owner (the entity's
 * clients and providers) don't need one and are left alone, as are points
 * without a name either.
 *
 * Written straight to the table: an update through the entity layer would run
 * the contact lifecycles for nothing.
 */
const CONTACT = 'api::contact.contact';

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

async function fillDeliveryPointTradeNames() {
  const points = await strapi.db.query(CONTACT).findMany({
    where: { owner: { $notNull: true } },
    select: ['id', 'name', 'trade_name'],
  });

  const fixes = points
    .filter((c) => blank(c.trade_name) && !blank(c.name))
    .map((c) => ({ id: c.id, trade_name: String(c.name).trim() }));

  if (fixes.length) {
    const { tableName } = strapi.db.metadata.get(CONTACT);
    for (const fix of fixes) {
      await strapi.db.connection(tableName).where({ id: fix.id }).update({ trade_name: fix.trade_name });
    }
  }

  strapi.log.info(
    `[fillDeliveryPointTradeNames] trade name set on ${fixes.length} delivery points` +
      (fixes.length ? ` (${fixes.map((f) => `#${f.id}`).join(', ')})` : ''),
  );
  return fixes;
}

module.exports = { fillDeliveryPointTradeNames };
