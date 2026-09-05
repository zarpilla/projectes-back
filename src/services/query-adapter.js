'use strict';

/**
 * v3 → v5 query-param adapter.
 *
 * Translates the v3 flat + `_where` query conventions used across the v3 projectes
 * controllers into the v5 Document Service / db.query options shape:
 *
 *   { filters, populate, sort, fields, pagination, status }
 *
 * Pure function — no Strapi dependency — so it is fully unit-testable.
 *
 * v3 patterns handled (see docs/DATA_ACCESS_CONVENTIONS.md for the full table):
 *   - _limit (-1 = all), _start, _sort ('field:DESC')
 *   - _q (full-text) → folded into filters as $or of $contains on string fields
 *     (caller passes the searchable field list), or returned as `q` for db.query
 *   - flat operators: field_eq/ne/lt/lte/gt/gte/in/nin/null/contains
 *   - bare field=value → eq
 *   - date-range: created_at_gte / created_at_lte etc. (same _gte/_lte handling)
 *   - _where[field_op] and flat field_op (both accepted by v3 controllers)
 *   - _where._or / _where._and → $or / $and
 *   - published_at_null (Draft & Publish) → status:'published' preference
 *   - populate passed separately (2nd positional arg in v3) → merged in
 */

const OPERATOR_SUFFIXES = [
  '_eq',
  '_ne',
  '_lt',
  '_lte',
  '_gt',
  '_gte',
  '_in',
  '_nin',
  '_null',
  '_contains',
  '_starts_with',
  '_ends_with',
];

const OP_MAP = {
  _eq: '$eq',
  _ne: '$ne',
  _lt: '$lt',
  _lte: '$lte',
  _gt: '$gt',
  _gte: '$gte',
  _in: '$in',
  _nin: '$notIn',
  _null: '$null',
  _contains: '$contains',
  _starts_with: '$startsWith',
  _ends_with: '$endsWith',
};

// Params that are NOT field filters (control params).
const CONTROL_PARAMS = new Set(['_limit', '_start', '_sort', '_q', 'published_at_null', '_where']);

function splitFieldOp(key) {
  // Returns { field, op } where op is the v3 suffix (e.g. '_gte') or null for bare field.
  for (const suf of OPERATOR_SUFFIXES) {
    if (key.endsWith(suf) && key.length > suf.length) {
      // the char before the suffix must be '_'-separated from the field,
      // i.e. the suffix already starts with '_'. Ensure we don't mis-split
      // a field literally named with the suffix.
      return { field: key.slice(0, -suf.length), op: suf };
    }
  }
  return { field: key, op: null };
}

function coerceValue(op, raw) {
  if (op === '_null') {
    return raw === true || raw === 'true' || raw === '' || raw === 1 || raw === '1';
  }
  if (op === '_in' || op === '_nin') {
    if (Array.isArray(raw)) return raw.map(coerceScalar);
    if (typeof raw === 'string')
      return raw
        .split(',')
        .map((s) => coerceScalar(s.trim()))
        .filter((s) => s !== '');
    return [coerceScalar(raw)];
  }
  return coerceScalar(raw);
}

function coerceScalar(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return v;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  // leave date strings, booleans-as-strings handled by _null branch
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Apply one v3 operator to a filters object.
 * Mutates/returns `filters`. Merges multiple operators on the same field
 * (e.g. created_at_gte + created_at_lte → { created_at: { $gte, $lte } }).
 */
function applyOp(filters, field, op, value) {
  // v3 addressed relation fields with a dotted path (`_where[contact_types.id]`,
  // `owner.id=3`). v5 filters are nested objects, so walk the path and apply the
  // operator on the leaf.
  if (field.includes('.')) {
    const segments = field.split('.');
    const leaf = segments.pop();
    let node = filters;
    for (const segment of segments) {
      const existing = node[segment];
      if (existing === undefined || typeof existing !== 'object' || Array.isArray(existing)) {
        node[segment] = {};
      }
      node = node[segment];
    }
    applyOp(node, leaf, op, value);
    return filters;
  }
  if (op === null || op === '_eq') {
    // bare field=value, or field_eq → scalar (v5 accepts field: value as $eq).
    // If the field already has operator(s), wrap as $eq and merge.
    if (filters[field] && typeof filters[field] === 'object' && !Array.isArray(filters[field])) {
      filters[field] = { ...filters[field], $eq: value };
    } else {
      filters[field] = value;
    }
    return filters;
  }
  if (op === '_null') {
    // value is already boolean. Merge into existing operator object if present.
    const opKey = value ? '$null' : '$notNull';
    const existing = filters[field];
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    filters[field] = { ...base, [opKey]: true };
    return filters;
  }
  if (op === '_in' || op === '_nin') {
    const existing = filters[field];
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    filters[field] = { ...base, [OP_MAP[op]]: value };
    return filters;
  }
  // generic range/string operators — merge so _gte + _lte coexist
  {
    const existing = filters[field];
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    filters[field] = { ...base, [OP_MAP[op]]: value };
    return filters;
  }
}

/**
 * Translate a v3 `_where` object (already parsed by qs into nested form) into v5 filters.
 * Handles `_where[field_op]` (flat) and `_where._or` / `_where._and`.
 */
function translateWhere(whereObj) {
  const filters = {};
  if (!whereObj || typeof whereObj !== 'object') return filters;
  for (const [key, rawValue] of Object.entries(whereObj)) {
    if (key === '_or' || key === 'or') {
      filters.$or = (Array.isArray(rawValue) ? rawValue : [rawValue]).map((clause) => translateWhere(clause));
      continue;
    }
    if (key === '_and' || key === 'and') {
      filters.$and = (Array.isArray(rawValue) ? rawValue : [rawValue]).map((clause) =>
        translateWhere(clause),
      );
      continue;
    }
    const { field, op } = splitFieldOp(key);
    applyOp(filters, field, op, coerceValue(op, rawValue));
  }
  return filters;
}

/**
 * Main entry: convert a v3 `ctx.query` object into v5 options.
 *
 * @param {object} query - the v3 query params (req.query / ctx.query)
 * @param {object} [opts]
 * @param {string[]} [opts.populate] - v3 populate array (2nd positional arg)
 * @param {string[]} [opts.searchFields] - fields to apply `_q` against (for $contains $or)
 * @returns {{filters:object, populate:(string[]|undefined), sort:object[], pagination:object, q:(string|undefined), status:(string|undefined)}}
 */
function adaptQuery(query, opts = {}) {
  const filters = {};
  const out = {
    filters,
    populate: opts.populate,
    sort: [],
    pagination: {},
    q: undefined,
    status: undefined,
  };

  if (!query || typeof query !== 'object') return out;

  // 1. _where (nested form) — translate first so flat params can override/duplicate safely.
  if (query._where) {
    Object.assign(filters, translateWhere(query._where));
  }

  // 2. pagination / sort / full-text control params
  if (query._limit !== undefined) {
    const limit = query._limit === '-1' ? -1 : parseInt(query._limit, 10);
    out.pagination.limit = Number.isNaN(limit) ? undefined : limit;
  }
  if (query._start !== undefined) {
    const start = parseInt(query._start, 10);
    if (!Number.isNaN(start)) out.pagination.start = start;
  }
  if (query._sort !== undefined) {
    // v3: 'field:DESC' | 'field:ASC' | 'field' → v5 [{ field: 'desc'|'asc' }]
    const parts = String(query._sort).split(':');
    const field = parts[0];
    const dir = (parts[1] || 'asc').toLowerCase();
    if (field) out.sort.push({ [field]: dir });
  }
  if (query._q !== undefined) {
    // v3 _q is full-text search. In v5 Document Service there's no direct equivalent
    // for arbitrary content types; expose as `q` (for db.query) AND, if searchFields
    // were provided, build an $or of $contains filters.
    out.q = String(query._q);
    if (opts.searchFields && opts.searchFields.length) {
      filters.$or = opts.searchFields.map((f) => ({ [f]: { $contains: out.q } }));
    }
  }

  // 3. published_at_null (Draft & Publish). v3 sets published_at_null:false in-controller.
  if (query.published_at_null !== undefined) {
    const v = coerceValue('_null', query.published_at_null);
    if (v === false) {
      // "not null" → published
      out.status = 'published';
    } else {
      filters.publishedAt = { $null: true };
    }
  }

  // 4. flat field operators (everything that isn't a control param or _where)
  for (const [key, rawValue] of Object.entries(query)) {
    if (CONTROL_PARAMS.has(key)) continue;
    if (key === '_where') continue;
    // v5-native params (populate, fields, status…) are not v3 field filters.
    if (V5_REST_PARAMS.has(key)) continue;
    const { field, op } = splitFieldOp(key);
    applyOp(filters, field, op, coerceValue(op, rawValue));
  }

  // Clean up empty containers
  if (out.sort.length === 0) delete out.sort;
  if (Object.keys(out.pagination).length === 0) delete out.pagination;

  return out;
}

/**
 * v3 `strapi.query(uid).find(params, populate)` took populate as a flat array of
 * dotted paths (`['project_phases', 'project_phases.incomes']`). v5 db.query
 * wants a nested object, so expand one into the other.
 *
 * @param {string[]} paths
 * @returns {object|undefined} v5 populate object (undefined for an empty list)
 */
function expandPopulate(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const root = {};
  for (const p of paths) {
    const segments = String(p).split('.').filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i];
      const last = i === segments.length - 1;
      const existing = node[key];
      if (last) {
        if (existing === undefined) node[key] = true;
        // a deeper path already created the object form — keep it
      } else {
        if (existing === undefined || existing === true) node[key] = { populate: {} };
        node = node[key].populate;
      }
    }
  }
  return root;
}

/**
 * v3's `_limit=-1` ("return everything") has no equivalent in `strapi.db.query`:
 * knex would emit `LIMIT -1`, which MySQL rejects. Omitting the limit is how v5
 * says "all rows", so custom controllers reading `adaptQuery` output must go
 * through this rather than passing `pagination.limit` straight to db.query.
 * (The REST path is different — `adaptCtxQuery` keeps the -1, which the REST
 * layer maps onto config/api.js `maxLimit`.)
 *
 * @param {object} opts the object returned by adaptQuery
 * @returns {number|undefined}
 */
function dbLimit(opts) {
  const limit = opts && opts.pagination && opts.pagination.limit;
  if (limit === undefined || limit === null || limit < 0) return undefined;
  return limit;
}

/**
 * v3 `strapi.query(uid).find(v3Query, populatePaths)` in one call: translates a
 * v3 query object plus a dotted populate list into the argument object
 * `strapi.db.query(uid).findMany()` expects.
 *
 * Note `_q` is not reproduced — v5 has no db-level full-text search, and the
 * ported controllers already ran the same query on both branches of their
 * `if (query._q)` check.
 *
 * @param {object} query v3 ctx.query
 * @param {string[]} [populatePaths] v3 dotted populate paths
 */
function v3FindArgs(query, populatePaths) {
  const opts = adaptQuery(query);
  const where = opts.filters || {};
  // db.query has no `status`; "published" is publishedAt IS NOT NULL.
  if (opts.status === 'published' && where.publishedAt === undefined) {
    where.publishedAt = { $notNull: true };
  }
  const args = { where };
  const populate = expandPopulate(populatePaths);
  if (populate) args.populate = populate;
  const limit = dbLimit(opts);
  if (limit !== undefined) args.limit = limit;
  if (opts.pagination && opts.pagination.start !== undefined) args.offset = opts.pagination.start;
  if (opts.sort) args.orderBy = opts.sort;
  return args;
}

/**
 * Params the v5 REST layer understands natively. Any OTHER query key means the
 * caller speaks v3 (_limit/_sort/_q/_where, published_at_null, or flat field
 * operators like `contact=5`) and must be translated first.
 */
const V5_REST_PARAMS = new Set([
  'filters',
  'sort',
  'pagination',
  'populate',
  'fields',
  'status',
  'publicationState',
  'locale',
]);

/**
 * In-place v3->v5 translation of ctx.query for core find overrides (P9).
 * Rewrites v3-style queries into native v5 REST params so the frontend can
 * keep sending the exact query strings it sent to v3. v5-native queries and
 * empty queries pass through untouched.
 */
function adaptCtxQuery(ctx, opts = {}) {
  const query = ctx && ctx.query;
  if (!query || typeof query !== 'object') return;
  const v3Keys = Object.keys(query).filter((k) => !V5_REST_PARAMS.has(k));
  if (v3Keys.length === 0) return;

  const adapted = adaptQuery(query, opts);
  // Carry over any v5-native params the caller (or the v3-compat middleware,
  // which defaults `populate` to '*') already put on the query — rebuilding
  // ctx.query from the v3 params alone used to drop them.
  const next = {};
  for (const key of V5_REST_PARAMS) {
    if (query[key] !== undefined) next[key] = query[key];
  }
  if (adapted.filters && Object.keys(adapted.filters).length) next.filters = adapted.filters;
  // REST query validation expects sort as an array of 'field:dir' strings
  // (the object form from adaptQuery is only valid for db.query orderBy).
  if (adapted.sort) next.sort = adapted.sort.map((entry) => {
    const [field, dir] = Object.entries(entry)[0];
    return `${field}:${dir}`;
  });
  if (adapted.pagination) next.pagination = adapted.pagination;
  if (adapted.status) next.status = adapted.status;
  if (adapted.populate) next.populate = adapted.populate;
  ctx.query = next;
}

module.exports = {
  adaptQuery,
  adaptCtxQuery,
  dbLimit,
  expandPopulate,
  v3FindArgs,
  // exported for testing
  _internal: { splitFieldOp, coerceValue, coerceScalar, translateWhere, applyOp },
};
