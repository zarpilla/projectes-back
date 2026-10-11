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
 * Derived from what OrdersTable and OrdersForm actually dereference. If they
 * start reading another field, add it here or it will silently be undefined.
 *
 * The order form used `contacts/basic?_where[owner_gt]=0` for its "Punt
 * d'entrega" list: 2 MB and 2 s on the production server, the last request of
 * a page that took 5-8 s (issues/016). It now asks for `?owned=1` here.
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
  // read by the order form when a delivery point is chosen
  'multiowner',
  'pickup_discount',
  'pickup_point',
];

// legal_form backs the CSV import's "no te sector" check; sector is read by the
// collection-point filtering in OrdersForm. Both are single-valued and cheap.
const FOR_ORDERS_POPULATE = { legal_form: true, sector: true };

// The socies list resolves an owner to its collection points. Only the ids are
// read, so the relations are selected down rather than populated whole.
const SOCIES_POPULATE = {
  ...FOR_ORDERS_POPULATE,
  // Only `.id` is ever read off this one.
  users_permissions_user: { select: ['id'] },
  // Whole rows, deliberately. These feed the "Punt de recollida en finca"
  // buttons, and trimming the select kept losing a field the UI needed:
  // first `city` (used to resolve the pickup city), then `name` (rendered on
  // the button). Only 29 of the 60 socies have collection points at all, so
  // the saving was never worth re-learning which fields matter.
  collection_points: true,
};

/**
 * The rows `GET /api/contacts/for-orders` answers with:
 * `?socies=1` the contacts linked to a user, `?owned=1` the delivery points
 * (contacts that have an owner, what the order form lists).
 */
function forOrdersWhere(query = {}) {
  const on = (v) => v === '1' || v === 'true';
  const where = {};
  if (on(query.socies)) where.users_permissions_user = { $notNull: true };
  if (on(query.owned)) where.owner = { $notNull: true };
  return where;
}

module.exports = { FOR_ORDERS_FIELDS, FOR_ORDERS_POPULATE, SOCIES_POPULATE, forOrdersWhere };
