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

let pluralToUid = null;

/** plural route name → collection-type uid, built once from the loaded schemas. */
function getPluralMap(strapi) {
  if (pluralToUid) return pluralToUid;
  pluralToUid = new Map();
  for (const [uid, ct] of Object.entries(strapi.contentTypes)) {
    if (!uid.startsWith('api::')) continue;
    if (ct.kind !== 'collectionType') continue;
    if (ct.info && ct.info.pluralName) pluralToUid.set(ct.info.pluralName, uid);
  }
  return pluralToUid;
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

/** v3 populated the first relation level on reads; v5 populates nothing. */
function defaultPopulate(ctx) {
  if (ctx.method === 'GET' && ctx.query.populate === undefined) {
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

  const [, plural, idSegment] = match;
  const uid = getPluralMap(strapi).get(plural);
  if (!uid) return next();

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
      ctx.path = `/api/${plural}/${encodeURIComponent(row.documentId)}`;
    }
  }

  // 2. v3 default populate for core reads
  defaultPopulate(ctx);

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
