'use strict';
/* global strapi */

/**
 * An order keeps a copy of its delivery point in its contact_* fields (the
 * address it was delivered to, even if the point changes later). Whoever moves
 * an order to another point has to refresh that copy, or the order carries the
 * old point's address (issues/157). The fields and their defaults follow
 * OrdersForm.onClientaChange, which fills them when a point is chosen there.
 */
const { relationId } = require('../../../services/relation-input');

const SNAPSHOT_FIELDS = {
  contact_name: 'name',
  contact_trade_name: 'trade_name',
  contact_nif: 'nif',
  contact_address: 'address',
  contact_postcode: 'postcode',
  contact_notes: 'notes',
  contact_phone: 'phone',
  contact_city: 'city',
  contact_time_slot_1_ini: 'time_slot_1_ini',
  contact_time_slot_1_end: 'time_slot_1_end',
  contact_time_slot_2_ini: 'time_slot_2_ini',
  contact_time_slot_2_end: 'time_slot_2_end',
};

/** The contact_* fields of an order delivered to `contact` (loaded with legal_form). */
function contactSnapshot(contact) {
  const data = {};
  for (const [field, source] of Object.entries(SNAPSHOT_FIELDS)) {
    data[field] = contact[source] === undefined ? null : contact[source];
  }
  data.contact_legal_form = relationId(contact.legal_form) || 1;
  data.contact_pickup_discount = contact.pickup_discount || 0;
  return data;
}

async function loadContact(id) {
  return strapi.db
    .query('api::contact.contact')
    .findOne({ where: { id }, populate: { legal_form: { select: ['id'] } } });
}

/**
 * For a write to order `orderId` that sets `contact` and no contact_* field
 * (the quick edit of the orders list): when the point changes, add the new
 * point's data to `payload`. The order form sends its own contact_* fields,
 * which are kept.
 */
async function addContactSnapshot(payload, orderId) {
  if (!payload || payload.contact === undefined) return payload;
  if (Object.keys(payload).some((k) => k.startsWith('contact_'))) return payload;
  const contactId = relationId(payload.contact);
  if (!contactId || typeof contactId !== 'number') return payload;

  if (orderId !== undefined && orderId !== null) {
    const where = /^\d+$/.test(String(orderId)) ? { id: Number(orderId) } : { documentId: orderId };
    const order = await strapi.db
      .query('api::order.order')
      .findOne({ where, populate: { contact: { select: ['id'] } } });
    if (order && relationId(order.contact) === contactId) return payload;
  }

  const contact = await loadContact(contactId);
  if (contact) Object.assign(payload, contactSnapshot(contact));
  return payload;
}

module.exports = { contactSnapshot, addContactSnapshot, loadContact, SNAPSHOT_FIELDS };
