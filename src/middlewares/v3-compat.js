'use strict';

/**
 * v3 → v5 REST transport compatibility (P9).
 *
 * The Vue frontend (`projectes-front`) addresses entities exactly the way it did
 * against Strapi 3.6, and the ETL deliberately preserved the numeric ids so it
 * could keep doing so. Two v5 changes break that, and this middleware closes
 * both for the core CRUD routes:
 *
 *   1. `/api/<plural>/:id` resolves `:id` as a **documentId** in v5, so a
 *      numeric id 404s. We look the row up by numeric id and rewrite the URL to
 *      its documentId before the router reads the params.
 *
 *   2. v3's `find`/`findOne` populated every first-level relation by default;
 *      v5 populates nothing unless asked. Views read `order.route.name`,
 *      `logo.logo.url`, … everywhere, so core reads default to `populate=*`
 *      (first level: relations, components and media — the v3 behaviour).
 *
 * Only the two exact core route shapes are touched. Custom routes
 * (`contacts/basic`, `orders/table`, `emitted-invoices/pdf/:doc/:id`, …) parse
 * their own query with `adaptQuery` and are left alone.
 */

const { adaptQuery } = require('../services/query-adapter');

const CORE_PATH = /^\/api\/([a-z0-9-]+)(?:\/([^/?]+))?$/;
/**
 * The users-permissions user routes. They address rows by their NUMERIC id
 * (the plugin's `fetch()` queries `where: { id }`), so they must NOT get the
 * documentId rewrite — only the v3 default populate, which is what puts `role`
 * and the `permissions` component back on the payload. The frontend's whole
 * authorization model reads `me.permissions.map(p => p.permission)`.
 */
const PLUGIN_USER_PATH = /^\/api\/users(?:\/(?:me|\d+))?$/;
// Exactly what v3's /users/me returned. `*` would also drag in `tasks` and the
// other reverse relations — 38KB per call, and the views delete them anyway.
const USER_POPULATE = ['role', 'permissions'];
const NUMERIC = /^\d+$/;
const DOCUMENT_ID = /^[a-z0-9]{20,}$/i;
const ID_METHODS = new Set(['GET', 'PUT', 'DELETE']);

let routeMap = null;

/**
 * route segment → { uid, kind }, built once from the loaded schemas.
 * Collection types are served at `/api/<pluralName>`, single types at
 * `/api/<singularName>` (v5 core router) — both need the v3 default populate,
 * but only collection types have an `/:id` to resolve.
 */
function getRouteMap(strapi) {
  if (routeMap) return routeMap;
  routeMap = new Map();
  for (const [uid, ct] of Object.entries(strapi.contentTypes)) {
    if (!uid.startsWith('api::')) continue;
    const info = ct.info || {};
    if (ct.kind === 'collectionType' && info.pluralName) {
      routeMap.set(info.pluralName, { uid, kind: 'collectionType' });
    } else if (ct.kind === 'singleType' && info.singularName) {
      routeMap.set(info.singularName, { uid, kind: 'singleType' });
    }
  }
  return routeMap;
}

/**
 * The users-permissions controllers do not go through `adaptCtxQuery` (they are
 * plugin code, not this project's), and they hand the query to
 * `query-params.transform`, which reads `filters`/`sort`/`populate`/`start`/
 * `limit` at the TOP level — not the nested `pagination` object the REST layer
 * uses. So `/api/users?_start=0&_limit=25&_sort=username:ASC` silently returned
 * every user, unsorted, until this translated it.
 */
function adaptUserQuery(ctx) {
  const query = ctx.query || {};
  const next = {};
  if (query.populate !== undefined) next.populate = query.populate;
  else next.populate = USER_POPULATE;

  const v3Keys = Object.keys(query).filter((k) => k !== 'populate');
  if (v3Keys.length === 0) {
    ctx.query = { ...query, ...next };
    return;
  }

  const adapted = adaptQuery(query);
  if (adapted.filters && Object.keys(adapted.filters).length) next.filters = adapted.filters;
  if (adapted.sort) {
    next.sort = adapted.sort.map((entry) => {
      const [field, dir] = Object.entries(entry)[0];
      return `${field}:${dir}`;
    });
  }
  // `limit: -1` is the documented "no limit" for this transform, so it can go
  // straight through; `pagination: {}` would be ignored entirely.
  if (adapted.pagination) {
    if (adapted.pagination.limit !== undefined) next.limit = adapted.pagination.limit;
    if (adapted.pagination.start !== undefined) next.start = adapted.pagination.start;
  }
  ctx.query = next;
}

/**
 * v3 ignored body keys that were not model fields; v5 answers
 * `400 ValidationError: Invalid key <k>` — and it validates NESTED payloads too
 * (`Invalid key created_at at leader`, `Invalid key total_expenses_vat at
 * project_phases.expenses`).
 *
 * The frontend edits the entity it just fetched and PUTs the whole graph back,
 * so every level carries things v5 will not take: the row identity, the managed
 * timestamps, and server-computed fields that are not schema attributes
 * (`allByYear` on a project, `total_expenses_vat` on a phase expense). Walk the
 * payload against the schema and drop them rather than failing the save.
 *
 * `id` and `documentId` survive below the top level: there they identify the
 * related row or the component entry, and v5 needs them.
 */
const MANAGED_KEYS = new Set([
  'createdAt',
  'updatedAt',
  // Draft & Publish is off everywhere (v5's version renumbers a row on every
  // save); Strapi still owns `publishedAt` and stamps it on every write.
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
]);
const IDENTITY_KEYS = new Set(['id', 'documentId']);

function attributesFor(def, strapi) {
  if (!def) return null;
  if (def.type === 'relation' && def.target) {
    const ct = strapi.contentTypes[def.target];
    return (ct && ct.attributes) || null;
  }
  if (def.type === 'component' && def.component) {
    const comp = strapi.components[def.component];
    return (comp && comp.attributes) || null;
  }
  return null;
}

/**
 * `{ id: 0 }` is how the frontend spells "not set" for a to-one relation —
 * ProjectForm initialises every select that way. v3's ORM stored it as NULL;
 * v5 rejects it with "1 relation(s) of type … do not exist". Same for a bare
 * `0` or an empty string.
 */
function isEmptyRelationRef(entry) {
  if (entry === null || entry === undefined || entry === '') return true;
  if (typeof entry === 'number') return entry <= 0;
  if (typeof entry === 'string') return !/^[1-9]\d*$/.test(entry);
  if (typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.documentId) return false;
  if (!Object.prototype.hasOwnProperty.call(entry, 'id')) return false;
  const { id } = entry;
  if (typeof id === 'number') return id <= 0;
  return !/^[1-9]\d*$/.test(String(id));
}

/** Turns the "not set" placeholders into what v5 understands: null, or absence. */
function dropEmptyRelations(value) {
  if (Array.isArray(value)) return value.filter((entry) => !isEmptyRelationRef(entry));
  return isEmptyRelationRef(value) ? null : value;
}

function cleanPayload(value, attributes, strapi, isRoot, depth) {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => cleanPayload(entry, attributes, strapi, isRoot, depth + 1));
  }
  const clean = {};
  for (const key of Object.keys(value)) {
    if (MANAGED_KEYS.has(key)) continue;
    if (IDENTITY_KEYS.has(key)) {
      if (isRoot) continue; // the URL identifies the row being written
      clean[key] = value[key];
      continue;
    }
    const def = attributes && attributes[key];
    if (!def) continue; // computed or unknown — v3 ignored these
    const nested = attributesFor(def, strapi);
    const cleaned = nested
      ? cleanPayload(value[key], nested, strapi, false, depth + 1)
      : value[key];
    clean[key] = def.type === 'relation' ? dropEmptyRelations(cleaned) : cleaned;
  }
  return clean;
}

function sanitizeWriteBody(ctx, uid, strapi) {
  const body = ctx.request.body;
  if (!body || typeof body !== 'object') return;
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  const ct = strapi.contentTypes[uid];
  const attributes = (ct && ct.attributes) || {};
  const clean = cleanPayload(data, attributes, strapi, true, 0);

  // The one v3 publication write the frontend makes: ProjectsTable's "trash"
  // sends `{ published_at: null }`. v5 owns the `published_at` column, so the
  // live/trashed state lives in `trashed` — translate the gesture onto it.
  if (Object.prototype.hasOwnProperty.call(data, 'published_at') && attributes.trashed) {
    clean.trashed = data.published_at === null || data.published_at === undefined;
  }
  body.data = clean;
}

/**
 * v3 populated the first relation level by default — on reads AND on the entity
 * a create/update echoed back; v5 populates nothing unless asked.
 */
function defaultPopulate(ctx) {
  if (ctx.query.populate === undefined) {
    ctx.query = { ...ctx.query, populate: '*' };
  }
}

module.exports = (config, { strapi }) => async (ctx, next) => {
  if (PLUGIN_USER_PATH.test(ctx.path || '')) {
    if (ctx.method === 'GET') adaptUserQuery(ctx);
    return next();
  }

  const match = CORE_PATH.exec(ctx.path || '');
  if (!match) return next();

  const [, segment, idSegment] = match;
  const entry = getRouteMap(strapi).get(segment);
  if (!entry) return next();
  const { uid, kind } = entry;

  // A single type has no `/:id`; `/api/me/dir3/...` is longer than this regex
  // matches, so anything trailing here is not a core route.
  if (kind === 'singleType') {
    if (idSegment !== undefined) return next();
    if (ctx.method === 'PUT') sanitizeWriteBody(ctx, uid, strapi);
    if (ctx.method === 'GET' || ctx.method === 'PUT') defaultPopulate(ctx);
    return next();
  }

  // `/api/contacts/basic`, `/api/orders/table`, … are custom actions, not core
  // CRUD on an entity. They parse their own query and must not be touched.
  const isCoreRoute =
    idSegment === undefined || NUMERIC.test(idSegment) || DOCUMENT_ID.test(idSegment);
  if (!isCoreRoute) return next();

  // 1. numeric id → documentId
  if (idSegment && NUMERIC.test(idSegment) && ID_METHODS.has(ctx.method)) {
    const row = await strapi.db
      .query(uid)
      .findOne({ where: { id: Number(idSegment) }, select: ['documentId'] });
    if (row && row.documentId) {
      // Ported controllers that still address rows by their numeric id read this
      // (see numericId() below) — ctx.params.id is the documentId from here on.
      ctx.state.v3 = { numericId: Number(idSegment), documentId: row.documentId };
      ctx.path = `/api/${segment}/${encodeURIComponent(row.documentId)}`;
    }
  }

  // 2. v3 default populate — the response of a write is populated too
  if (ctx.method === 'GET' || ctx.method === 'POST' || ctx.method === 'PUT') defaultPopulate(ctx);

  // 3. drop write-body keys v5 would reject
  if (ctx.method === 'POST' || ctx.method === 'PUT') sanitizeWriteBody(ctx, uid, strapi);

  return next();
};

/**
 * The numeric id of the addressed row, for controllers ported from v3 that query
 * `where: { id }` or build v3-style URLs. Falls back to `ctx.params.id` when the
 * middleware did not rewrite (custom routes keep their numeric params).
 */
function numericId(ctx) {
  const fromState = ctx && ctx.state && ctx.state.v3 && ctx.state.v3.numericId;
  if (fromState !== undefined && fromState !== null) return fromState;
  return ctx && ctx.params ? ctx.params.id : undefined;
}

module.exports.numericId = numericId;
// exported for testing
module.exports._internal = { cleanPayload, isEmptyRelationRef };
