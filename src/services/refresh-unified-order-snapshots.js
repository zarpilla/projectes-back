'use strict';
/* global strapi */

/**
 * Startup script (issues/157): before the fix, «Unificar» punts d'entrega and
 * the orders quick edit moved an order to another point without refreshing its
 * copy of the point (contact_*), so it still carries the old point's address.
 * Unify did not delete the source point, so that old point is still there.
 *
 * An order is stale when its contact_* data (name + address + postcode + city,
 * ignoring whitespace, case and accents) is not its own point's but is another
 * existing point's. It gets its own point's data, built as Unificar builds it
 * now (contactSnapshot). Orders whose data is no point's (hand edits) or their
 * own point's are left alone. Delivered and invoiced orders are refreshed too
 * (agreed on the ticket); the invoices are untouched.
 *
 * Written straight to the tables: the order lifecycles would recompute prices
 * and send notifications. The link tables are read from the schema metadata,
 * so tenants built by the v3 ETL resolve the same way.
 *
 * Idempotent: a refreshed order carries its own point's data and is not
 * picked again.
 */
const { contactSnapshot, SNAPSHOT_FIELDS } = require('../api/order/services/contact-snapshot');

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';
const BATCH = 2000;
const KEY_FIELDS = ['name', 'address', 'postcode', 'city'];

const norm = (v) =>
  v === null || v === undefined
    ? ''
    : String(v)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/** The comparison key of a point's data, or null when too weak to match on. */
function dataKey(get) {
  const parts = KEY_FIELDS.map((f) => norm(get(f)));
  const [name, address] = parts;
  if (!name || !address) return null;
  return parts.join('|');
}

const contactKey = (c) => dataKey((f) => c[f]);
const orderKey = (o) => dataKey((f) => o[`contact_${f}`]);

/**
 * Orders (`{ id, contact, contact_* }`, contact = point id) whose data is
 * another existing point's and not their own. Returns `{ id, contact, matches }`
 * with the ids of the points whose data they carry.
 */
function selectStaleSnapshots(orders, contacts) {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const byKey = new Map();
  for (const c of contacts) {
    const key = contactKey(c);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c.id);
  }

  const stale = [];
  for (const order of orders) {
    const own = byId.get(order.contact);
    if (!own) continue;
    const key = orderKey(order);
    if (!key || key === contactKey(own)) continue;
    const matches = (byKey.get(key) || []).filter((id) => id !== own.id);
    if (matches.length) stale.push({ id: order.id, contact: own.id, matches });
  }
  return stale;
}

async function loadContacts() {
  const { tableName, attributes } = strapi.db.metadata.get(CONTACT);
  const columns = ['id', ...Object.values(SNAPSHOT_FIELDS), 'pickup_discount'];
  const rows = await strapi.db.connection(tableName).select(columns);
  const lf = attributes.legal_form.joinTable;
  const links = await strapi.db
    .connection(lf.name)
    .select([lf.joinColumn.name, lf.inverseJoinColumn.name]);
  const legalForm = new Map(links.map((l) => [l[lf.joinColumn.name], l[lf.inverseJoinColumn.name]]));
  // a v3 sentinel 0 counts as unset, as the populate reads it (contactSnapshot falls back to 1)
  return rows.map((r) => ({ ...r, legal_form: legalForm.get(r.id) || null }));
}

/** Orders by id ranges, each with its point id. */
async function* orderBatches() {
  const { tableName, attributes } = strapi.db.metadata.get(ORDER);
  const link = attributes.contact.joinTable;
  const orderCol = link.joinColumn.name;
  const contactCol = link.inverseJoinColumn.name;
  const columns = ['id', ...Object.keys(SNAPSHOT_FIELDS).filter((f) => KEY_FIELDS.includes(SNAPSHOT_FIELDS[f]))];
  let last = 0;
  for (;;) {
    const rows = await strapi.db
      .connection(tableName)
      .select(columns)
      .where('id', '>', last)
      .orderBy('id')
      .limit(BATCH);
    if (!rows.length) return;
    last = rows[rows.length - 1].id;
    const ids = rows.map((r) => r.id);
    const links = await strapi.db.connection(link.name).select([orderCol, contactCol]).whereIn(orderCol, ids);
    const contactOf = new Map(links.map((l) => [l[orderCol], l[contactCol]]));
    yield rows.map((r) => ({ ...r, contact: contactOf.get(r.id) || null }));
    if (rows.length < BATCH) return;
  }
}

async function writeSnapshot(orderId, contact) {
  const { tableName, attributes } = strapi.db.metadata.get(ORDER);
  const { contact_legal_form: legalFormId, ...columns } = contactSnapshot(contact);
  await strapi.db.connection(tableName).where({ id: orderId }).update(columns);
  const lf = attributes.contact_legal_form.joinTable;
  await strapi.db.connection(lf.name).where({ [lf.joinColumn.name]: orderId }).del();
  await strapi.db
    .connection(lf.name)
    .insert({ [lf.joinColumn.name]: orderId, [lf.inverseJoinColumn.name]: legalFormId });
}

async function refreshUnifiedOrderSnapshots() {
  const contacts = await loadContacts();
  const byId = new Map(contacts.map((c) => [c.id, c]));

  let total = 0;
  const changed = [];
  for await (const orders of orderBatches()) {
    total += orders.length;
    const rowById = new Map(orders.map((o) => [o.id, o]));
    for (const s of selectStaleSnapshots(orders, contacts)) {
      await writeSnapshot(s.id, byId.get(s.contact));
      const old = rowById.get(s.id);
      changed.push({ ...s, from: `${old.contact_name}, ${old.contact_address}` });
    }
  }

  strapi.log.info(
    `[refreshUnifiedOrderSnapshots] ${changed.length} of ${total} orders given their point's data` +
      (changed.length
        ? `: ${changed
            .map((c) => `#${c.id} point ${c.contact} (had point ${c.matches.join('/')}'s «${c.from}»)`)
            .join(', ')}`
        : ''),
  );
  return changed;
}

module.exports = { refreshUnifiedOrderSnapshots, selectStaleSnapshots };
