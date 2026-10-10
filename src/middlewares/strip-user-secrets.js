'use strict';

/**
 * Removes the users' credentials from every API answer.
 *
 * Strapi drops a user's private fields when a core action sanitizes its output,
 * but the controllers ported from v3 answer with what `strapi.db.query` returned,
 * and a populated user comes back from there whole. `projects/:id`,
 * `projects/basic`, `projects/:id/phases` and `project-original-phases-hours`
 * sent the bcrypt hash and the reset-password token of every user they
 * populated (estimated hours, leaders) to any logged-in user (issues/028).
 *
 * Fixing each populate would only last until the next one is written, so this
 * is enforced here, on the way out, for everything under /api.
 */

const SECRET_KEYS = ['password', 'resetPasswordToken', 'confirmationToken'];
const MAX_DEPTH = 40;

function stripUserSecrets(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) stripUserSecrets(value[i], depth + 1);
    return value;
  }
  // Files and streams are not JSON answers; dates have nothing to walk.
  if (Buffer.isBuffer(value) || value instanceof Date || typeof value.pipe === 'function') return value;
  for (const key of SECRET_KEYS) {
    if (key in value) delete value[key];
  }
  for (const key in value) stripUserSecrets(value[key], depth + 1);
  return value;
}

module.exports = () => async (ctx, next) => {
  await next();
  if ((ctx.path || '').startsWith('/api/')) stripUserSecrets(ctx.body);
};

module.exports.stripUserSecrets = stripUserSecrets;
