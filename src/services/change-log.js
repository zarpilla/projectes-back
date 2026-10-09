'use strict';
/* global strapi */

/**
 * Change log for emitted and received invoices (issues/001): every create,
 * update and delete is recorded in api::document-change-log with who did it,
 * when (createdAt), and each changed field's old and new value.
 *
 * Hooked as a document-service middleware (registered in src/index.js), not a
 * db lifecycle: on update v5 rewrites the component rows (the invoice lines,
 * contact_info) BEFORE the db beforeUpdate runs, so a snapshot taken there
 * already holds the new lines and line edits would never show in the diff.
 * The middleware wraps the whole action, so it sees the row as it really was
 * and as it ended up after the lifecycles (locked fields, recomputed totals).
 *
 * Writes that bypass the document service must call logRawUpdate themselves
 * (the VAT payment's raw UPDATE in the emitted-invoice controller).
 *
 * Logging never fails the write it describes: errors are reported and dropped.
 */

const LOG_UID = 'api::document-change-log.document-change-log';

const TRACKED = {
  'api::emitted-invoice.emitted-invoice': 'emitted-invoice',
  'api::received-invoice.received-invoice': 'received-invoice',
};

// Bookkeeping, not content: changing them is not something a person did.
// `pdf`/`qr` are regenerated, `user_last` is the author we already record,
// `updatable_admin` is the one-shot unlock flag reset on every save.
const IGNORED_FIELDS = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'locale',
  'createdBy',
  'updatedBy',
  'localizations',
  'pdf',
  'qr',
  'user_last',
  'updatable_admin',
]);

// Strapi-managed keys of a component row: they change when the row is
// re-created on save without the line itself changing.
const COMPONENT_META = new Set(['id', '__component', '__pivot', 'documentId']);

const isTracked = (uid) => Object.prototype.hasOwnProperty.call(TRACKED, uid);

function attributesOf(uid) {
  const model = strapi.contentTypes && strapi.contentTypes[uid];
  return (model && model.attributes) || {};
}

function isNested(attr) {
  return attr && (attr.type === 'relation' || attr.type === 'component' || attr.type === 'media');
}

// Populate every relation, component and media of the type, one level deep
// (ignored ones too: `user_last` is the fallback author in currentUser).
function populateFor(uid) {
  const populate = {};
  for (const [name, attr] of Object.entries(attributesOf(uid))) {
    if (isNested(attr)) populate[name] = true;
  }
  return populate;
}

async function snapshot(uid, where) {
  return strapi.db.query(uid).findOne({ where, populate: populateFor(uid) });
}

function relationLabel(row) {
  return row.code || row.name || row.username || row.email || String(row.id);
}

function normalizeRelation(row) {
  if (row === null || row === undefined) return null;
  if (typeof row !== 'object') return { id: row };
  return { id: row.id, label: relationLabel(row) };
}

function normalizeComponent(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!COMPONENT_META.has(key)) out[key] = normalizeScalar(value);
  }
  return out;
}

function normalizeScalar(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** The comparable, JSON-safe form of one attribute's value. */
function normalizeValue(attr, value) {
  if (attr && (attr.type === 'relation' || attr.type === 'media')) {
    if (Array.isArray(value)) {
      return value.map(normalizeRelation).sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
    }
    return normalizeRelation(value);
  }
  if (attr && attr.type === 'component') {
    return Array.isArray(value) ? value.map(normalizeComponent) : normalizeComponent(value);
  }
  return normalizeScalar(value);
}

// An unset relation reads as null on one side and [] on the other.
function isEmpty(value) {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function sameValue(a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  // Decimals may come back as '100.00' from one query and 100 from another.
  if (a !== null && b !== null && typeof a !== 'object' && typeof b !== 'object') {
    const na = Number(a);
    const nb = Number(b);
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Field-by-field differences between two rows of `uid`.
 * @returns {{ field: string, from: any, to: any }[]}
 */
function diff(uid, before, after) {
  const changes = [];
  const attributes = attributesOf(uid);
  for (const [field, attr] of Object.entries(attributes)) {
    if (IGNORED_FIELDS.has(field)) continue;
    const from = normalizeValue(attr, before ? before[field] : null);
    const to = normalizeValue(attr, after ? after[field] : null);
    if (!sameValue(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

/** Every non-empty field of a row, for the create/delete records. */
function summarize(uid, row) {
  if (!row) return null;
  const out = {};
  for (const [field, attr] of Object.entries(attributesOf(uid))) {
    if (IGNORED_FIELDS.has(field)) continue;
    const value = normalizeValue(attr, row[field]);
    if (!isEmpty(value)) out[field] = value;
  }
  return out;
}

/**
 * The user behind the current request. Falls back to the row's `user_last`
 * (the views stamp it on every save) when there is no request, e.g. a write
 * made from a script.
 */
function currentUser(row) {
  const ctx = strapi.requestContext && strapi.requestContext.get();
  let user = (ctx && ctx.state && ctx.state.user) || null;
  if (!user && row && row.user_last && typeof row.user_last === 'object') user = row.user_last;
  if (!user) return { user_id: null, username: null };
  return { user_id: user.id || null, username: user.username || user.email || null };
}

async function record(uid, { action, row, changes = null, snapshot: snap = null }) {
  await strapi.db.query(LOG_UID).create({
    data: {
      entity: TRACKED[uid],
      entity_id: row ? row.id : null,
      document_code: row ? row.code || null : null,
      action,
      changes,
      snapshot: snap,
      ...currentUser(row),
    },
  });
}

function report(error, uid, action) {
  const message = `[change-log] could not log ${action} on ${uid}: ${error && error.message}`;
  if (strapi.log) strapi.log.error(message);
  else console.error(message);
}

function whereFromParams(params) {
  if (!params) return null;
  if (params.documentId) return { documentId: params.documentId };
  if (params.id) return { id: params.id };
  return null;
}

/**
 * Document-service middleware: strapi.documents.use(changeLogMiddleware).
 * Only create/update/delete on the tracked types are looked at.
 */
async function changeLogMiddleware(context, next) {
  const { uid, action, params } = context;
  if (!isTracked(uid) || !['create', 'update', 'delete'].includes(action)) {
    return next();
  }

  let before = null;
  if (action !== 'create') {
    try {
      const where = whereFromParams(params);
      if (where) before = await snapshot(uid, where);
    } catch (error) {
      report(error, uid, action);
    }
  }

  const result = await next();

  try {
    if (action === 'create') {
      const created = result && result.id ? await snapshot(uid, { id: result.id }) : null;
      if (created) await record(uid, { action, row: created, snapshot: summarize(uid, created) });
    } else if (action === 'update') {
      if (before) {
        const after = await snapshot(uid, { id: before.id });
        const changes = diff(uid, before, after);
        if (changes.length > 0) await record(uid, { action, row: after || before, changes });
      }
    } else if (before) {
      await record(uid, { action, row: before, snapshot: summarize(uid, before) });
    }
  } catch (error) {
    report(error, uid, action);
  }

  return result;
}

/**
 * For writes made outside the document service (raw SQL). Call with the row
 * snapshot taken before the write; the change is diffed against the row now.
 */
async function logRawUpdate(uid, before) {
  if (!isTracked(uid) || !before) return;
  try {
    const after = await snapshot(uid, { id: before.id });
    const changes = diff(uid, before, after);
    if (changes.length > 0) await record(uid, { action: 'update', row: after || before, changes });
  } catch (error) {
    report(error, uid, 'update');
  }
}

module.exports = {
  LOG_UID,
  TRACKED,
  isTracked,
  snapshot,
  diff,
  summarize,
  changeLogMiddleware,
  logRawUpdate,
};
