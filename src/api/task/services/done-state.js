'use strict';

/**
 * The "done" task state: the last one by order (Acabades), when there are at least
 * two. The front (board, list, overdue notice) uses the same rule; the digest used
 * to compare with the id 3, which is not the last state on every tenant.
 */
function doneStateId(states) {
  if (!states || states.length < 2) return null;
  const last = states.reduce((a, b) => ((b.order ?? 0) >= (a.order ?? 0) ? b : a));
  return last.id;
}

module.exports = { doneStateId };
