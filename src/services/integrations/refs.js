'use strict';
/* global strapi */

/**
 * Which order or delivery point each `external_id` of a member's system is
 * (integrations API, api/integration). One row per (owner_id, kind,
 * external_id) of content type api::integration.integration-ref.
 *
 * The uniqueness is a database index (`ensureRefsIndex`, at boot): Strapi's
 * `unique` is checked by the application only, and two requests at once
 * could both pass it. That is why owner_id is an integer and not a relation:
 * a relation lives in a link table, where no index can reach it.
 *
 * The row is reserved before the order or point is written and completed
 * after (`reserve` → `complete`, or `release` when the write fails). An order
 * or point the office deleted leaves its row behind: `findRefs` callers check
 * that the target still exists, and `release` the row when it doesn't.
 */

const { rawExecute } = require('../raw-sql');

const UID = 'api::integration.integration-ref';
const TABLE = 'integration_refs';
const INDEX = 'integration_refs_owner_kind_ext_uq';
const MAX_EXTERNAL_ID = 191;

/**
 * The unique index on (owner_id, kind, external_id). Rerun on every boot,
 * like ensureOrderInvoiceUniqueIndex: Strapi doesn't know the index, and a
 * table rebuilt without it gets it back.
 */
async function ensureRefsIndex() {
  const existing = await rawExecute(
    strapi,
    'SELECT 1 AS found FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [TABLE, INDEX],
  );
  if (Array.isArray(existing) && existing.length > 0) return false;
  await rawExecute(strapi, `CREATE UNIQUE INDEX ${INDEX} ON ${TABLE} (owner_id, kind, external_id)`, []);
  strapi.log.info(`[integrations] unique index ${INDEX} created`);
  return true;
}

const targetColumn = (kind) => (kind === 'order' ? 'order_id' : 'contact_id');

/** The rows of these external ids: Map external_id → { id, target } (target null while reserved). */
async function findRefs(ownerId, kind, externalIds) {
  if (!externalIds.length) return new Map();
  const rows = await strapi.db
    .query(UID)
    .findMany({ where: { owner_id: ownerId, kind, external_id: { $in: externalIds } } });
  return new Map(
    rows.map((r) => [
      r.external_id,
      { id: r.id, target: r[targetColumn(kind)] || null, requestedDate: r.requested_date || null },
    ]),
  );
}

/** The external ids of these targets: Map target id → external_id. */
async function externalIdsOf(ownerId, kind, targetIds) {
  if (!targetIds.length) return new Map();
  const column = targetColumn(kind);
  const rows = await strapi.db
    .query(UID)
    .findMany({ where: { owner_id: ownerId, kind, [column]: { $in: targetIds } } });
  return new Map(rows.map((r) => [r[column], r.external_id]));
}

const isDuplicate = (error) =>
  Boolean(error) &&
  (error.code === 'ER_DUP_ENTRY' ||
    error.errno === 1062 ||
    /Duplicate entry|ER_DUP_ENTRY/i.test(String(error.message)) ||
    isDuplicate(error.cause));

/** Takes the external id before writing; null when another request already holds it. */
async function reserve(ownerId, kind, externalId) {
  try {
    const row = await strapi.db
      .query(UID)
      .create({ data: { owner_id: ownerId, kind, external_id: externalId } });
    return row.id;
  } catch (error) {
    if (isDuplicate(error)) return null;
    throw error;
  }
}

async function complete(refId, kind, targetId, extra = {}) {
  await strapi.db
    .query(UID)
    .update({ where: { id: refId }, data: { [targetColumn(kind)]: targetId, ...extra } });
}

/** The day the member asked for an order (it may have gone to a later route day). */
async function setRequestedDate(refId, day) {
  await strapi.db.query(UID).update({ where: { id: refId }, data: { requested_date: day || null } });
}

async function release(refId) {
  await strapi.db.query(UID).delete({ where: { id: refId } });
}

/** Links an existing target (a delivery point she already had) to an external id. */
async function link(ownerId, kind, externalId, targetId) {
  const refId = await reserve(ownerId, kind, externalId);
  if (!refId) return false;
  await complete(refId, kind, targetId);
  return true;
}

module.exports = {
  UID,
  TABLE,
  INDEX,
  MAX_EXTERNAL_ID,
  ensureRefsIndex,
  findRefs,
  externalIdsOf,
  reserve,
  complete,
  setRequestedDate,
  release,
  link,
  isDuplicate,
};
