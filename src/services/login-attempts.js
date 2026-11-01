'use strict';

/**
 * Failed logins per account (issues/400). The users-permissions limit counts
 * per IP only (issues/376), so from many addresses one account could be
 * guessed without end. After MAX_FAILURES wrong passwords for one identifier
 * within WINDOW_MS, that identifier is refused from any address until the
 * window of its first failure ends. A correct login clears the count.
 *
 * In memory, per process (one per tenant slot), like the IP limit.
 */

const MAX_FAILURES = 20;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 10000;

const failures = new Map();

const keyOf = (identifier) => (typeof identifier === 'string' ? identifier.trim().toLowerCase() : '');

function prune(now) {
  for (const [key, entry] of failures) if (now - entry.first >= WINDOW_MS) failures.delete(key);
}

/** Whether `identifier` has used up its failed tries. */
function isLocked(identifier, now = Date.now()) {
  const entry = failures.get(keyOf(identifier));
  if (!entry) return false;
  if (now - entry.first >= WINDOW_MS) {
    failures.delete(keyOf(identifier));
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(identifier, now = Date.now()) {
  const key = keyOf(identifier);
  if (!key) return;
  if (failures.size >= MAX_KEYS) prune(now);
  const entry = failures.get(key);
  if (!entry || now - entry.first >= WINDOW_MS) failures.set(key, { first: now, count: 1 });
  else entry.count += 1;
}

function recordSuccess(identifier) {
  failures.delete(keyOf(identifier));
}

module.exports = { isLocked, recordFailure, recordSuccess, MAX_FAILURES, WINDOW_MS, _failures: failures };
