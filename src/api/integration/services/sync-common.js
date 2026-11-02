'use strict';

/**
 * What the three write endpoints of the integrations API share: the
 * external_id of each item, the result of each item and the summary, and
 * one request at a time per member.
 *
 * Each item is independent: one rejected item doesn't stop the others, and
 * the answer is 200 with a result per item. Only a malformed request (not a
 * list, too many items) is refused as a whole.
 */
const { MAX_EXTERNAL_ID } = require('../../../services/integrations/refs');

const MAX_ITEMS = 500;

const RESULTS = [
  'created',
  'updated',
  'linked',
  'unchanged',
  'cancelled',
  'already_cancelled',
  'not_found',
  'rejected',
];

/** The external_id of an item, trimmed, or an error message. */
function externalIdOf(item) {
  const raw = item && typeof item === 'object' ? item.external_id : undefined;
  if (raw === undefined || raw === null || (typeof raw !== 'string' && typeof raw !== 'number')) {
    return { error: 'Falta external_id' };
  }
  const value = String(raw).trim();
  if (!value) return { error: 'Falta external_id' };
  if (value.length > MAX_EXTERNAL_ID)
    return { error: `external_id massa llarg (màxim ${MAX_EXTERNAL_ID} caràcters)` };
  return { value };
}

/** The items of a request body, or why the body is refused as a whole. */
function itemsOf(body, field) {
  const list = body && typeof body === 'object' ? body[field] : undefined;
  if (!Array.isArray(list)) return { error: `El cos ha de portar una llista «${field}»` };
  if (!list.length) return { error: `La llista «${field}» és buida` };
  if (list.length > MAX_ITEMS) return { error: `Com a màxim ${MAX_ITEMS} elements per petició` };
  return { items: list };
}

const dryRunOf = (body) =>
  Boolean(body && (body.dry_run === true || body.dry_run === 'true' || body.dry_run === 1));

/** A refused item: a stable code and the reason in Catalan. */
class ItemRejection extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const reject = (code, message, extra) => {
  throw new ItemRejection(code, message, extra);
};

/** A 400/403 thrown by the app's own rules (lifecycles, member scopes) becomes a rejected item. */
function rejectionOf(error) {
  if (error instanceof ItemRejection) return { code: error.code, message: error.message, ...error.extra };
  const name = error && error.name;
  if (name === 'ForbiddenError' || name === 'PolicyError') {
    return { code: 'FORBIDDEN', message: 'No tens permís per fer aquesta acció' };
  }
  if (name === 'ValidationError' || name === 'ApplicationError' || name === 'YupValidationError') {
    return { code: 'INVALID', message: error.message };
  }
  return null;
}

function summaryOf(results) {
  const summary = { received: results.length };
  for (const key of RESULTS) summary[key] = 0;
  for (const r of results) summary[r.result] = (summary[r.result] || 0) + 1;
  return summary;
}

/**
 * Runs `items` one after the other through `handle(item, index, ctx)`.
 * Duplicated external_ids in the same request are refused after the first.
 */
async function runItems(items, handle, log) {
  const seen = new Set();
  const results = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const ext = externalIdOf(item);
    const base = { index, external_id: ext.value !== undefined ? ext.value : null };
    if (ext.error) {
      results.push({ ...base, result: 'rejected', code: 'INVALID', message: ext.error });
      continue;
    }
    if (seen.has(ext.value)) {
      results.push({
        ...base,
        result: 'rejected',
        code: 'DUPLICATE_IN_REQUEST',
        message: 'Aquest external_id ja surt abans en aquesta petició',
      });
      continue;
    }
    seen.add(ext.value);
    try {
      results.push({ ...base, ...(await handle(item, ext.value, index)) });
    } catch (error) {
      const rejection = rejectionOf(error);
      if (rejection) {
        results.push({ ...base, result: 'rejected', ...rejection });
      } else {
        if (log)
          log.error(
            `[integrations] item ${index} (${ext.value}): ${error && error.stack ? error.stack : error}`,
          );
        results.push({
          ...base,
          result: 'rejected',
          code: 'ERROR',
          message: "Error intern en desar aquest element. Torna-ho a provar més tard o avisa l'oficina.",
        });
      }
    }
  }
  return results;
}

// one request at a time per member: the discounts of an order depend on her
// other orders, and the external_ids are looked up before they are written
const queues = new Map();

function withOwnerLock(ownerId, fn) {
  const previous = queues.get(ownerId) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(ownerId, tail);
  tail.then(() => {
    if (queues.get(ownerId) === tail) queues.delete(ownerId);
  });
  return run;
}

module.exports = {
  MAX_ITEMS,
  RESULTS,
  externalIdOf,
  itemsOf,
  dryRunOf,
  ItemRejection,
  reject,
  rejectionOf,
  summaryOf,
  runItems,
  withOwnerLock,
};
