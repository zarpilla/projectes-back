'use strict';

/**
 * `GET /api/contacts/withorders`: the contacts the user's orders go to, with
 * how many there are and whether one is delivered or invoiced (`can_edit`).
 *
 * It loaded every order of the user, whole, with its contact populated, and
 * counted them in JavaScript with a linear search per order. On diligencia
 * an office user owns thousands of orders: 11 s at the median, 25 s at worst,
 * holding the backend the whole time (issues/326). One grouped query over the
 * order links answers the counts; the contacts are then read once each.
 */

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';

// the statuses that let a member edit the delivery point (ContactsUserForm)
const EDITABLE_STATUSES = ['delivered', 'invoiced'];

/**
 * `[{ contact, num_orders, can_edit }]` for the orders owned by `userId`
 * (to `contactId` only, when given), in the order of each contact's first order.
 */
async function ordersPerContact(strapi, userId, contactId) {
  const { tableName, attributes } = strapi.db.metadata.get(ORDER);
  const owner = attributes.owner.joinTable;
  const contact = attributes.contact.joinTable;
  const contactCol = `oc.${contact.inverseJoinColumn.name}`;
  const knex = strapi.db.connection;
  const editable = EDITABLE_STATUSES.map(() => '?').join(', ');

  const query = knex(`${tableName} as o`)
    .join(`${owner.name} as ow`, `ow.${owner.joinColumn.name}`, 'o.id')
    .join(`${contact.name} as oc`, `oc.${contact.joinColumn.name}`, 'o.id')
    .where(`ow.${owner.inverseJoinColumn.name}`, userId)
    .groupBy(contactCol)
    .select({ contact: contactCol })
    .select(knex.raw('COUNT(DISTINCT o.id) as num_orders'))
    .select(
      knex.raw(`MAX(CASE WHEN o.status IN (${editable}) THEN 1 ELSE 0 END) as can_edit`, EDITABLE_STATUSES),
    )
    .select(knex.raw('MIN(o.id) as first_order'))
    .orderBy('first_order');
  if (contactId !== undefined && contactId !== null && contactId !== '') {
    query.where(contactCol, contactId);
  }
  const rows = await query;
  return rows.map((row) => ({
    contact: Number(row.contact),
    num_orders: Number(row.num_orders),
    can_edit: Number(row.can_edit) === 1,
  }));
}

/** The response: each contact as `/basic` gives it, plus `num_orders` and `can_edit`. */
async function contactsWithOrders(strapi, userId, contactId, populate) {
  const counts = await ordersPerContact(strapi, userId, contactId);
  if (!counts.length) return [];
  const contacts = await strapi.db.query(CONTACT).findMany({
    where: { id: { $in: counts.map((c) => c.contact) } },
    populate,
  });
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return counts
    .filter((c) => byId.has(c.contact))
    .map((c) => ({ ...byId.get(c.contact), num_orders: c.num_orders, can_edit: c.can_edit }));
}

module.exports = { ordersPerContact, contactsWithOrders, EDITABLE_STATUSES };
