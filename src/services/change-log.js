'use strict';
/* global strapi */

/**
 * Change log for emitted and received invoices (issues/001) and for orders
 * (issues/119): every create, update and delete is recorded in
 * api::document-change-log with who did it, when (createdAt), and each changed
 * field's old and new value. The rows outlive the record they describe (a
 * plain `entity_id`, no relation), so a deleted order keeps its history.
 *
 * Hooked as a document-service middleware (registered in src/index.js), not a
 * db lifecycle: on update v5 rewrites the component rows (the invoice lines,
 * contact_info) BEFORE the db beforeUpdate runs, so a snapshot taken there
 * already holds the new lines and line edits would never show in the diff.
 * The middleware wraps the whole action, so it sees the row as it really was
 * and as it ended up after the lifecycles (locked fields, recomputed totals).
 *
 * Writes that bypass the document service must call logRawUpdate (or, for a
 * bulk raw UPDATE whose changes are known, logChanges) themselves: the VAT
 * payment in the emitted-invoice controller, invoicing orders and deleting
 * their draft, merging contacts.
 *
 * Orders also change behind the document service: the order lifecycles'
 * follow-up writes (a sibling's discounts, the collection order they create
 * and keep up to date, the transfer route) and merging contacts go through
 * strapi.db.query. A db lifecycle subscriber (registerOrderRowWrites) records
 * those too. Inside an order's document action it hands its rows to the
 * action, which drops the ones about the order being saved: those changes are
 * already in the action's own diff.
 *
 * Received incomes, received expenses and quotes are tracked the same way, and
 * an emitted invoice's history also has what happens outside its saves: sent
 * by email, each VeriFactu and FACe status (issues/161).
 *
 * Logging never fails the write it describes: errors are reported and dropped.
 */

const { AsyncLocalStorage } = require('async_hooks');

const LOG_UID = 'api::document-change-log.document-change-log';

// The document action in progress: { uid, id, action, entries }.
const actionScope = new AsyncLocalStorage();

const ORDER_UID = 'api::order.order';

const EMITTED_UID = 'api::emitted-invoice.emitted-invoice';

const TRACKED = {
  [EMITTED_UID]: 'emitted-invoice',
  'api::received-invoice.received-invoice': 'received-invoice',
  // issues/161: the other documents get the same history
  'api::received-income.received-income': 'received-income',
  'api::received-expense.received-expense': 'received-expense',
  'api::quote.quote': 'quote',
  [ORDER_UID]: 'order',
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

// Per type. An order's incidences are linked by the controller after the
// order's own save, outside the action this middleware wraps, so the diff
// would catch some links and miss others (issues/119).
const IGNORED_BY_TYPE = {
  [ORDER_UID]: new Set(['incidences']),
};

const isIgnored = (uid, field) =>
  IGNORED_FIELDS.has(field) || Boolean(IGNORED_BY_TYPE[uid] && IGNORED_BY_TYPE[uid].has(field));

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

const LABEL_FIELDS = ['code', 'name', 'username', 'email'];

// A related row is only kept as { id, label }: read just those columns (an
// order has some twenty relations, and is snapshotted twice per save).
function relationPopulate(attr) {
  if (attr.type !== 'relation' || !attr.target) return true;
  const target = strapi.contentTypes && strapi.contentTypes[attr.target];
  if (!target || !target.attributes) return true;
  return { select: ['id', ...LABEL_FIELDS.filter((f) => target.attributes[f])] };
}

// Populate every tracked relation, component and media of the type, one level
// deep. `skip`: fields left out (an update's components it does not send).
function populateFor(uid, skip = null) {
  const populate = {};
  for (const [name, attr] of Object.entries(attributesOf(uid))) {
    if (isNested(attr) && !isIgnored(uid, name) && !(skip && skip.has(name))) {
      populate[name] = relationPopulate(attr);
    }
  }
  return populate;
}

async function snapshot(uid, where, skip = null) {
  return strapi.db.query(uid).findOne({ where, populate: populateFor(uid, skip) });
}

/**
 * The components an update leaves alone: not in its data, so v5 does not
 * touch their rows. Not reading them keeps a save of a 1000-line invoice (La
 * Dotzena's monthly one, issues/161) from loading and comparing every line
 * twice when only, say, the paid date changed.
 */
function untouchedComponents(uid, data) {
  const skip = new Set();
  for (const [name, attr] of Object.entries(attributesOf(uid))) {
    if (attr.type === 'component' && !(data && Object.prototype.hasOwnProperty.call(data, name))) skip.add(name);
  }
  return skip;
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

function rowChanges(from, to) {
  const changes = [];
  const keys = new Set([...Object.keys(from || {}), ...Object.keys(to || {})]);
  for (const key of keys) {
    const a = from && from[key] !== undefined ? from[key] : null;
    const b = to && to[key] !== undefined ? to[key] : null;
    if (!sameValue(a, b)) changes.push({ field: key, from: a, to: b });
  }
  return changes;
}

/**
 * What changed in a repeatable component (the lines), line by line, or null.
 * Storing both whole lists made a one-line edit of a 1000-line invoice a log
 * row of ~2000 lines (issues/161). Lines equal on both sides are matched
 * whatever their position (v5 re-creates the rows on save); the rest are
 * paired in order as changed lines, and what is left over was added or
 * removed. `index` is the 1-based position (in the new list; in the old one
 * for removed lines).
 */
function listDiff(fromList, toList) {
  const from = fromList || [];
  const to = toList || [];
  const unmatched = new Map();
  from.forEach((row, i) => {
    const key = JSON.stringify(row);
    if (!unmatched.has(key)) unmatched.set(key, []);
    unmatched.get(key).push(i);
  });
  const toLeft = [];
  to.forEach((row, i) => {
    const same = unmatched.get(JSON.stringify(row));
    if (same && same.length) same.shift();
    else toLeft.push(i);
  });
  const fromLeft = [...unmatched.values()].flat().sort((a, b) => a - b);
  if (fromLeft.length === 0 && toLeft.length === 0) return null;

  const paired = Math.min(fromLeft.length, toLeft.length);
  const changed = [];
  for (let k = 0; k < paired; k++) {
    changed.push({ index: toLeft[k] + 1, changes: rowChanges(from[fromLeft[k]], to[toLeft[k]]) });
  }
  return {
    added: toLeft.slice(paired).map((i) => ({ index: i + 1, row: to[i] })),
    removed: fromLeft.slice(paired).map((i) => ({ index: i + 1, row: from[i] })),
    changed,
  };
}

/**
 * Field-by-field differences between two rows of `uid` (only `fields`, when given).
 * A repeatable component comes as `{ field, from: <count>, to: <count>, lines }`
 * with `lines` from listDiff.
 * @returns {{ field: string, from: any, to: any, lines?: object }[]}
 */
function diff(uid, before, after, fields = null) {
  const changes = [];
  const attributes = attributesOf(uid);
  for (const [field, attr] of Object.entries(attributes)) {
    if (isIgnored(uid, field) || (fields && !fields.includes(field))) continue;
    const from = normalizeValue(attr, before ? before[field] : null);
    const to = normalizeValue(attr, after ? after[field] : null);
    if (attr.type === 'component' && (Array.isArray(from) || Array.isArray(to))) {
      const lines = listDiff(from, to);
      if (lines) changes.push({ field, from: (from || []).length, to: (to || []).length, lines });
    } else if (!sameValue(from, to)) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}

/** Every non-empty field of a row, for the create/delete records. */
function summarize(uid, row) {
  if (!row) return null;
  const out = {};
  for (const [field, attr] of Object.entries(attributesOf(uid))) {
    if (isIgnored(uid, field)) continue;
    const value = normalizeValue(attr, row[field]);
    if (!isEmpty(value)) out[field] = value;
  }
  return out;
}

/**
 * The user behind the current request. Without one (a scheduled job, the
 * VeriFactu or FACe workers, a startup script) nobody is recorded and the
 * history shows «Sistema»: falling back to the row's `user_last` named the
 * last person who saved it as the author of what the system did (issues/161).
 */
function currentUser() {
  const ctx = strapi.requestContext && strapi.requestContext.get();
  const user = (ctx && ctx.state && ctx.state.user) || null;
  if (!user) return { user_id: null, username: null };
  return { user_id: user.id || null, username: user.username || user.email || null };
}

async function record(uid, { action, row, changes = null, snapshot: snap = null, details = null }) {
  await strapi.db.query(LOG_UID).create({
    data: {
      entity: TRACKED[uid],
      entity_id: row ? row.id : null,
      document_code: row ? row.code || null : null,
      action,
      changes,
      snapshot: snap,
      details,
      ...currentUser(),
    },
  });
}

function report(error, uid, action) {
  const message = `[change-log] could not log ${action} on ${uid}: ${error && error.message}`;
  if (strapi.log && typeof strapi.log.error === 'function') strapi.log.error(message);
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
  const skip = action === 'update' ? untouchedComponents(uid, params && params.data) : null;
  if (action !== 'create') {
    try {
      const where = whereFromParams(params);
      if (where) before = await snapshot(uid, where, skip);
    } catch (error) {
      report(error, uid, action);
    }
  }

  const scope = { uid, id: before ? before.id : null, action, entries: [] };
  const result = await actionScope.run(scope, () => next());

  try {
    if (action === 'create') {
      const created = result && result.id ? await snapshot(uid, { id: result.id }) : null;
      if (created) await record(uid, { action, row: created, snapshot: summarize(uid, created) });
    } else if (action === 'update') {
      if (before) {
        const after = await snapshot(uid, { id: before.id }, skip);
        const changes = diff(uid, before, after);
        if (changes.length > 0) await record(uid, { action, row: after || before, changes });
      }
    } else if (before) {
      await record(uid, { action, row: before, snapshot: summarize(uid, before) });
    }
  } catch (error) {
    report(error, uid, action);
  }

  // what the follow-up writes changed on other rows
  const mainId = action === 'create' ? result && result.id : before && before.id;
  for (const entry of scope.entries) {
    if (entry.row.id === mainId) continue;
    try {
      await record(uid, entry);
    } catch (error) {
      report(error, uid, entry.action);
    }
  }

  return result;
}

// --- writes behind the document service (orders) ---------------------------

const ROW_WRITES = [ORDER_UID];

/** The tracked attributes a db.query write sets. */
function fieldsWritten(uid, data) {
  const attributes = attributesOf(uid);
  return Object.keys(data || {}).filter((f) => attributes[f] && !isIgnored(uid, f));
}

async function rowWith(uid, where, fields) {
  const all = populateFor(uid);
  const populate = {};
  for (const f of fields) if (all[f]) populate[f] = all[f];
  return strapi.db.query(uid).findOne({ where, populate });
}

// Inside a document action of the same type the row waits for the action
// (which knows which row it saved); anywhere else it is written now.
async function emit(uid, entry) {
  const scope = actionScope.getStore();
  if (scope && scope.uid === uid) scope.entries.push(entry);
  else await record(uid, entry);
}

const isMainRow = (scope, uid, id) => Boolean(scope && scope.uid === uid && scope.id != null && scope.id === id);

async function beforeRowUpdate(event) {
  const uid = event.model && event.model.uid;
  try {
    const { where, data } = event.params || {};
    if (!where || isMainRow(actionScope.getStore(), uid, where.id)) return;
    const fields = fieldsWritten(uid, data);
    if (fields.length === 0) return;
    const before = await rowWith(uid, where, fields);
    if (before) event.state.changeLog = { before, fields };
  } catch (error) {
    report(error, uid, 'update');
  }
}

async function afterRowUpdate(event) {
  const uid = event.model && event.model.uid;
  const pending = event.state && event.state.changeLog;
  if (!pending) return;
  try {
    const { before, fields } = pending;
    const after = await rowWith(uid, { id: before.id }, fields);
    const changes = diff(uid, before, after, fields);
    if (changes.length > 0) await emit(uid, { action: 'update', row: after || before, changes });
  } catch (error) {
    report(error, uid, 'update');
  }
}

async function afterRowCreate(event) {
  const uid = event.model && event.model.uid;
  try {
    const id = event.result && event.result.id;
    if (!id) return;
    // the action's own row: it records it itself (the lifecycles flag theirs)
    const scope = actionScope.getStore();
    const data = (event.params && event.params.data) || {};
    if (scope && scope.uid === uid && scope.action === 'create' && !data._internal) return;
    const created = await snapshot(uid, { id });
    if (created) await emit(uid, { action: 'create', row: created, snapshot: summarize(uid, created) });
  } catch (error) {
    report(error, uid, 'create');
  }
}

/** Records the orders' db.query writes (issues/119). Called from bootstrap. */
function registerOrderRowWrites() {
  strapi.db.lifecycles.subscribe({
    models: ROW_WRITES,
    beforeUpdate: beforeRowUpdate,
    afterUpdate: afterRowUpdate,
    afterCreate: afterRowCreate,
  });
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

/**
 * For bulk raw UPDATEs whose changes are known without reading the rows back
 * (invoicing orders, deleting their draft). `entries`: [{ row: { id, code? },
 * changes: [{ field, from, to }] }]; changes that change nothing are dropped.
 */
async function logChanges(uid, entries) {
  if (!isTracked(uid) || !Array.isArray(entries)) return;
  const attributes = attributesOf(uid);
  for (const { row, changes } of entries) {
    try {
      const real = (changes || [])
        .map(({ field, from, to }) => ({
          field,
          from: normalizeValue(attributes[field], from),
          to: normalizeValue(attributes[field], to),
        }))
        .filter(({ from, to }) => !sameValue(from, to));
      if (row && real.length > 0) await record(uid, { action: 'update', row, changes: real });
    } catch (error) {
      report(error, uid, 'update');
    }
  }
}

// --- events that are not a save of the document (issues/161) ---------------

/**
 * Something that happened to a document without being a save of it: sent by
 * email, a VeriFactu or FACe status change. `row`: { id, code? }.
 */
async function logEvent(uid, { action, row, changes = null, details = null }) {
  if (!isTracked(uid) || !row || !row.id) return;
  try {
    await record(uid, { action, row, changes, details });
  } catch (error) {
    report(error, uid, action);
  }
}

// The emitted invoice's submissions: a VeriFactu chain row per submission, a
// FACe queue row per invoice. Their workers write them with strapi.db.query
// and update the status in place, so each status they reach goes in the
// invoice's history here, with when it happened.
const SUBMISSIONS = {
  'api::verifactu-chain.verifactu-chain': { action: 'verifactu', field: 'state', details: ['mode'] },
  'api::face-queue.face-queue': { action: 'face', field: 'status', details: ['mode', 'registration_number'] },
};

async function submissionRow(uid, where) {
  return strapi.db.query(uid).findOne({
    where,
    populate: { emitted_invoice: { select: ['id', 'code'] } },
  });
}

async function logSubmission(uid, before, after) {
  const { action, field, details } = SUBMISSIONS[uid];
  const invoice = after && after.emitted_invoice;
  const from = before ? before[field] || null : null;
  const to = after ? after[field] || null : null;
  if (!invoice || !invoice.id || from === to) return;
  const extra = {};
  for (const key of details) if (after[key] !== null && after[key] !== undefined) extra[key] = after[key];
  await logEvent(EMITTED_UID, {
    action,
    row: { id: invoice.id, code: invoice.code },
    changes: [{ field, from, to }],
    details: Object.keys(extra).length ? extra : null,
  });
}

async function beforeSubmissionUpdate(event) {
  const uid = event.model && event.model.uid;
  try {
    const { where, data } = event.params || {};
    if (!where || !data || !Object.prototype.hasOwnProperty.call(data, SUBMISSIONS[uid].field)) return;
    const before = await submissionRow(uid, where);
    if (before) event.state.changeLog = { before };
  } catch (error) {
    report(error, uid, 'update');
  }
}

async function afterSubmissionUpdate(event) {
  const uid = event.model && event.model.uid;
  const pending = event.state && event.state.changeLog;
  if (!pending) return;
  try {
    await logSubmission(uid, pending.before, await submissionRow(uid, { id: pending.before.id }));
  } catch (error) {
    report(error, uid, 'update');
  }
}

async function afterSubmissionCreate(event) {
  const uid = event.model && event.model.uid;
  try {
    const id = event.result && event.result.id;
    if (id) await logSubmission(uid, null, await submissionRow(uid, { id }));
  } catch (error) {
    report(error, uid, 'create');
  }
}

/** VeriFactu and FACe statuses in the invoice's history. Called from bootstrap. */
function registerSubmissionWrites() {
  strapi.db.lifecycles.subscribe({
    models: Object.keys(SUBMISSIONS),
    beforeUpdate: beforeSubmissionUpdate,
    afterUpdate: afterSubmissionUpdate,
    afterCreate: afterSubmissionCreate,
  });
}

// --- reading ----------------------------------------------------------------

/** The change log of one record, newest first (rows of a deleted one too). */
async function historyOf(uid, id) {
  if (!isTracked(uid)) return [];
  return strapi.db.query(LOG_UID).findMany({
    where: { entity: TRACKED[uid], entity_id: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

const LINE_DETAIL_LIMIT = 50;

// The detail of a big line change, capped: the history shows the first lines
// and how many there are.
function compactChange(change) {
  if (!change || !change.lines) return change;
  const cap = (list) => (list || []).slice(0, LINE_DETAIL_LIMIT);
  const { added = [], removed = [], changed = [] } = change.lines;
  return {
    ...change,
    lines: {
      added: cap(added),
      removed: cap(removed),
      changed: cap(changed),
      counts: { added: added.length, removed: removed.length, changed: changed.length },
    },
  };
}

// A create/delete snapshot carries every line: the history only needs how many.
function compactSnapshot(uid, snap) {
  if (!snap) return snap;
  const attributes = attributesOf(uid);
  const out = {};
  for (const [key, value] of Object.entries(snap)) {
    const attr = attributes[key];
    out[key] = attr && attr.type === 'component' && Array.isArray(value) ? value.length : value;
  }
  return out;
}

/**
 * One page of a record's history, newest first, ready for the forms: line
 * changes and snapshots compacted (issues/161).
 * @returns {Promise<{ total: number, entries: object[] }>}
 */
async function historyPage(uid, id, { start = 0, limit = 50 } = {}) {
  if (!isTracked(uid)) return { total: 0, entries: [] };
  const where = { entity: TRACKED[uid], entity_id: id };
  const [rows, total] = await Promise.all([
    strapi.db.query(LOG_UID).findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      offset: start,
      limit,
    }),
    strapi.db.query(LOG_UID).count({ where }),
  ]);
  const entries = rows.map(({ id: rowId, action, changes, snapshot: snap, details, user_id, username, createdAt }) => ({
    id: rowId,
    action,
    changes: Array.isArray(changes) ? changes.map(compactChange) : changes,
    snapshot: compactSnapshot(uid, snap),
    details: details || null,
    user_id,
    username,
    createdAt,
  }));
  return { total, entries };
}

/** The uid of a tracked entity name ('emitted-invoice' …), or null. */
function uidOf(entity) {
  return Object.keys(TRACKED).find((uid) => TRACKED[uid] === entity) || null;
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
  logChanges,
  logEvent,
  historyOf,
  historyPage,
  uidOf,
  listDiff,
  registerOrderRowWrites,
  registerSubmissionWrites,
  beforeSubmissionUpdate,
  afterSubmissionUpdate,
  afterSubmissionCreate,
  beforeRowUpdate,
  afterRowUpdate,
  afterRowCreate,
};
