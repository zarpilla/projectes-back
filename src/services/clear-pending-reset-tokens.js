'use strict';
/* global strapi */

/**
 * Startup script (issues/384): every pending password reset token is cleared.
 *
 * Until this fix any logged-in user could read another user's reset token
 * through a filter, and the tokens never expired. Those still stored may have
 * been read, so they go; whoever was resetting asks for a new link (it now
 * lasts one hour).
 *
 * Idempotent: only rows with a token.
 */
const USER = 'plugin::users-permissions.user';

async function clearPendingResetTokens() {
  const { tableName } = strapi.db.metadata.get(USER);
  const count = await strapi.db
    .connection(tableName)
    .whereNotNull('reset_password_token')
    .update({ reset_password_token: null });
  strapi.log.info(`[clearPendingResetTokens] ${count} pending reset tokens cleared`);
  return count;
}

module.exports = { clearPendingResetTokens };
