'use strict';

/**
 * What the orders page needs from the contact list, and nothing else.
 *
 * OrdersTable was loading `contacts?_limit=-1` — the core route, which the
 * v3-compat middleware gives `populate: '*'`. Measured on ~1175 contacts that
 * is 126ms of database work and 942ms of contentAPI.sanitize.output, for a
 * 2.02 MB payload; the second call (`users_permissions_user_gt=0`, 811 rows)
 * pays the same tax again. Sanitisation dominates and scales with rows ×
 * fields, so populating less barely helps — the fix is to stop shipping the
 * whole contact.
 *
 * Selecting only these fields brings the payload to ~0.4 MB, and a custom
 * handler returns db.query rows directly, so the sanitise pass is skipped the
 * way /contacts/basic already does.
 *
 * Derived from what OrdersTable actually dereferences. If it starts reading
 * another field, add it here or it will silently be undefined.
 */
const FOR_ORDERS_FIELDS = [
  'id',
  'name',
  'trade_name',
  'nif',
  'phone',
  'address',
  'city',
  'postcode',
  'notes',
  'notes_delivery',
  'time_slot_1_ini',
  'time_slot_1_end',
  'time_slot_2_ini',
  'time_slot_2_end',
];

// legal_form backs the CSV import's "no te sector" check; sector is read by the
// collection-point filtering in OrdersForm. Both are single-valued and cheap.
const FOR_ORDERS_POPULATE = { legal_form: true, sector: true };

// The socies list resolves an owner to its collection points. Only the ids are
// read, so the relations are selected down rather than populated whole.
const SOCIES_POPULATE = {
  ...FOR_ORDERS_POPULATE,
  users_permissions_user: { select: ['id'] },
  // `city` as well as the id: OrdersForm resolves a collection point's city
  // NAME against the cities list to work out the pickup city. `city` is a
  // plain column on contact, not a relation, so it selects cleanly.
  collection_points: { select: ['id', 'city'] },
};

module.exports = { FOR_ORDERS_FIELDS, FOR_ORDERS_POPULATE, SOCIES_POPULATE };
