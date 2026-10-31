'use strict';

/**
 * Refuses filters and sorts on fields the caller must not read (issues/384).
 *
 * A filter answers yes or no for every row, so a field that never comes back in
 * the response can still be read character by character: whether rows come
 * back is enough. The custom endpoints (orders/table, activities/calendar,
 * projects/basic…) pass the request's filters straight to `strapi.db.query`
 * through the v3 adapter, which skips Strapi's own query validation. A member
 * read an admin's password reset token through `_where[deposit_user.
 * resetPasswordToken_lt]=…` on `/orders/table` and took over the account.
 *
 * Checked on every API request, before the controller, whatever form the
 * query takes: v3 `_where[...]`, flat `field_op=…`, v5 `filters[...]`, sorts
 * (`_sort`, `sort`) and the filters/sorts inside `populate`. Every path segment
 * is compared after dropping case, underscores and the operator suffix: the
 * database layer passes an unknown key through as a column name, so
 * `reset_password_token` or `RESETPASSWORDTOKEN` reach the same column.
 *
 * - Everybody: the private attributes of every content type (password, reset
 *   and confirmation tokens, certificate passwords, API tokens).
 * - Users without full access: also what the response sanitizer hides from
 *   them (salaries, identity, project finances).
 */

const OPERATOR_SUFFIX =
  /_(eq|ne|lt|lte|gt|gte|in|nin|null|contains|containss|ncontains|starts_with|ends_with|not_null)$/;

// always private, whatever the schemas say
const CREDENTIALS = ['password', 'resetPasswordToken', 'confirmationToken'];

const normalize = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The names of a path segment to compare: as written, and without its operator. */
function segmentNames(segment) {
  const raw = String(segment).replace(/^\$+/, '');
  if (!raw) return [];
  return [normalize(raw), normalize(raw.replace(OPERATOR_SUFFIX, ''))];
}

/** A set of normalized field names. */
function nameSet(names) {
  return new Set(names.map(normalize).filter(Boolean));
}

/** The first segment of `path` (a key or a sort string) that is in `names`. */
function offendingSegment(path, names) {
  for (const segment of String(path).split(/[.[\]:,\s]+/)) {
    if (segmentNames(segment).some((name) => names.has(name))) return segment;
  }
  return null;
}

/**
 * The first forbidden field reached by `query`, or null.
 *
 * @param {object} query  ctx.query
 * @param {Set<string>} names  normalized names (nameSet)
 */
function forbiddenField(query, names) {
  const sortValues = (value) => {
    if (typeof value === 'string') return offendingSegment(value, names);
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = sortValues(v);
        if (hit) return hit;
      }
      return null;
    }
    if (value && typeof value === 'object') return walk(value, 'filter');
    return null;
  };

  // mode 'filter': keys are field paths. mode 'populate': only the filters and
  // sorts found inside count (populated fields are cleaned from the response).
  function walk(node, mode) {
    if (!node || typeof node !== 'object') return null;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'sort' || key === '_sort') {
        const hit = sortValues(value);
        if (hit) return hit;
        continue;
      }
      if (key === 'fields') continue;
      if (key === 'populate') {
        const hit = walk(value, 'populate');
        if (hit) return hit;
        continue;
      }
      if (mode === 'populate') {
        const hit = walk(value, key === 'filters' ? 'filter' : 'populate');
        if (hit) return hit;
        continue;
      }
      if (key !== 'filters' && key !== '_where') {
        const hit = offendingSegment(key, names);
        if (hit) return hit;
      }
      if (value && typeof value === 'object') {
        const hit = walk(value, 'filter');
        if (hit) return hit;
      }
    }
    return null;
  }

  return walk(query, 'filter');
}

/** The private attributes of every content type and component. */
function privateAttributes(app) {
  const names = [...CREDENTIALS];
  const groups = [app && app.contentTypes, app && app.components];
  for (const group of groups) {
    for (const model of Object.values(group || {})) {
      for (const [name, attribute] of Object.entries((model && model.attributes) || {})) {
        if (attribute && attribute.private) names.push(name);
      }
    }
  }
  return names;
}

// the `home` attribute (Inici pins) is private only to keep it out of /users
const NOT_SECRET = new Set(['home']);

let cached = null;

/** The two name sets, built once from the schemas. */
function guardSets(app = global.strapi) {
  if (cached && cached.app === app) return cached;
  const { USER_PRIVATE, DEDICATION_SALARY_FIELDS, PROJECT_FINANCES } = require('./response-sanitizer');
  const secret = privateAttributes(app).filter((name) => !NOT_SECRET.has(name));
  const everybody = nameSet(secret);
  const limited = nameSet([
    ...secret,
    ...USER_PRIVATE,
    ...DEDICATION_SALARY_FIELDS,
    ...PROJECT_FINANCES,
    'cost_by_hour',
    'invoice_hours_price',
  ]);
  cached = { app, everybody, limited };
  return cached;
}

module.exports = { forbiddenField, guardSets, nameSet, CREDENTIALS };
