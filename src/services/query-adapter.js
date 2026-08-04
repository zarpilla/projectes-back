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
    const { field, op } = splitFieldOp(key);
    applyOp(filters, field, op, coerceValue(op, rawValue));
  }

  // Clean up empty containers
  if (out.sort.length === 0) delete out.sort;
  if (Object.keys(out.pagination).length === 0) delete out.pagination;

  return out;
}

module.exports = {
  adaptQuery,
  // exported for testing
  _internal: { splitFieldOp, coerceValue, coerceScalar, translateWhere, applyOp },
};
