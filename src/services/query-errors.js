'use strict';

/**
 * Tell a query the client got wrong from a server failure. An unknown filter
 * (`GET /api/activities/calendar?user=8`, issues/225) reached the database as a
 * column that does not exist, or Strapi refused the where clause, and the
 * endpoint answered a bare 500. These are the client's mistake: 400.
 */
const { errors: dbErrors } = require('@strapi/database');

// MySQL / MariaDB, PostgreSQL and SQLite codes for an unknown column or a
// value of the wrong type
const BAD_QUERY_CODES = new Set([
  'ER_BAD_FIELD_ERROR',
  'ER_TRUNCATED_WRONG_VALUE',
  'ER_WRONG_VALUE',
  '42703',
  '22007',
  '22P02',
]);

// the plain Errors thrown by @strapi/database while building a where clause
const BAD_QUERY_MESSAGES =
  /Undefined attribute level operator|Where must be an array or an object|Operator .* must be an array|Operator and non-operator keys|Only one operator key|can only be used as root level operators|no such column/;

function isBadQueryError(err) {
  if (!err) return false;
  if (
    err instanceof dbErrors.InvalidDateError ||
    err instanceof dbErrors.InvalidDateTimeError ||
    err instanceof dbErrors.InvalidTimeError ||
    err instanceof dbErrors.InvalidRelationError
  ) {
    return true;
  }
  if (err.code && BAD_QUERY_CODES.has(String(err.code))) return true;
  return BAD_QUERY_MESSAGES.test(String(err.message || ''));
}

/**
 * Run `fn` (a query built from ctx.query). A bad query answers 400 with the
 * reason; anything else is rethrown.
 */
async function withBadQueryAs400(ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isBadQueryError(err)) {
      return ctx.badRequest(`Invalid query: ${err.sqlMessage || err.message}`);
    }
    throw err;
  }
}

module.exports = { isBadQueryError, withBadQueryAs400 };
