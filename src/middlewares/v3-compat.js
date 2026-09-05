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

const CORE_PATH = /^\/api\/([a-z0-9-]+)(?:\/([^/?]+))?$/;
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

module.exports = (config, { strapi }) => async (ctx, next) => {
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
      ctx.path = `/api/${plural}/${encodeURIComponent(row.documentId)}`;
    }
  }

  // 2. v3 default populate for core reads
  if (ctx.method === 'GET' && ctx.query.populate === undefined) {
    ctx.query = { ...ctx.query, populate: '*' };
  }

  return next();
};
