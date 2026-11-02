'use strict';
/* global strapi */

/**
 * API keys of the integrations API (api/integration): a member's own system
 * (La Dotzena's) creates and cancels her orders and delivery points with a key
 * sent in the `x-api-key` header, instead of the CSV import. The office creates
 * and revokes the keys from Administració › Usuàries.
 *
 * A key belongs to one user and acts in her name, with her rules. Only its
 * SHA-256 is stored (`key_hash`, private): the key itself is shown once, when
 * it is created. It has 256 random bits, so a plain hash is enough.
 *
 * Content type api::integration.api-key, hidden from the admin panel and with
 * no core routes: it is only reached through the admin routes of
 * api/integration and the `api-key` policy.
 */
const crypto = require('crypto');

const UID = 'api::integration.api-key';
// «esk» = ESSTrapis key; the prefix makes a leaked key easy to recognise
const KEY_PREFIX = 'esk_';
// the first characters of the key, kept in clear to tell the keys apart
const SHOWN_LENGTH = KEY_PREFIX.length + 8;
// last_used_at is written at most once a minute per key
const TOUCH_EVERY_MS = 60 * 1000;

const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');

function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** What the admin screen shows of a key: never its hash. */
function keyOut(row) {
  return {
    id: row.id,
    user: row.user_id,
    name: row.name || null,
    prefix: row.prefix,
    createdAt: row.createdAt,
    createdBy: row.issued_by || null,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
    active: !row.revoked_at,
  };
}

/** A new key for `userId`: the key itself is in the answer, and only there. */
async function createKey({ userId, name = null, createdBy = null }) {
  const key = generateKey();
  const row = await strapi.db.query(UID).create({
    data: {
      user_id: userId,
      name: name ? String(name).trim().slice(0, 255) || null : null,
      prefix: key.slice(0, SHOWN_LENGTH),
      key_hash: hashKey(key),
      issued_by: createdBy,
    },
  });
  return { ...keyOut(row), key };
}

async function listKeys(userId) {
  const rows = await strapi.db.query(UID).findMany({ where: { user_id: userId }, orderBy: { id: 'desc' } });
  return rows.map(keyOut);
}

async function findKey(id) {
  const row = await strapi.db.query(UID).findOne({ where: { id } });
  return row ? keyOut(row) : null;
}

/** Revoked keys are kept (who had one, until when); they no longer authenticate. */
async function revokeKey(id) {
  const { count } = await strapi.db
    .query(UID)
    .updateMany({ where: { id, revoked_at: { $null: true } }, data: { revoked_at: new Date() } });
  return count > 0;
}

const lastTouch = new Map();

/** The active key row for a key sent in a request, or null. */
async function authenticateKey(key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const row = await strapi.db
    .query(UID)
    .findOne({ where: { key_hash: hashKey(key), revoked_at: { $null: true } } });
  if (!row) return null;
  const now = Date.now();
  if (!lastTouch.has(row.id) || now - lastTouch.get(row.id) > TOUCH_EVERY_MS) {
    lastTouch.set(row.id, now);
    await strapi.db.query(UID).update({ where: { id: row.id }, data: { last_used_at: new Date(now) } });
  }
  return row;
}

module.exports = {
  UID,
  KEY_PREFIX,
  hashKey,
  generateKey,
  createKey,
  listKeys,
  findKey,
  revokeKey,
  authenticateKey,
  keyOut,
};
