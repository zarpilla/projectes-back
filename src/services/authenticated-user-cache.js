'use strict';

/**
 * Keeps the authenticated user (with her role) in the read cache between
 * requests (issues/307).
 *
 * The users-permissions strategy loads the user and her role on every request
 * (`fetchAuthenticatedUser`: two queries), and then checks `blocked`,
 * `confirmed` and the role. Kept in the read cache, the answer is dropped as
 * soon as the user, her role link or the role change: at once when the change
 * is made by this process (blocking someone from the admin screens, changing
 * her role), within the stamps' few seconds when it comes from another one.
 * The access token itself is still validated on every request by the plugin.
 *
 * The user's secrets (password hash, reset and confirmation tokens) are taken
 * out of what is loaded, so they are never kept; nothing reads them from
 * `ctx.state.user` (changing the password reads the user again).
 */

const { getReadCache } = require('./read-cache');
const { stripUserSecrets } = require('../middlewares/strip-user-secrets');

const USER = 'plugin::users-permissions.user';

function userTables() {
  try {
    const meta = global.strapi.db.metadata.get(USER);
    return meta && meta.tableName ? [meta.tableName] : [];
  } catch {
    return [];
  }
}

/** Wraps the users-permissions `user` service. Returns it. */
function cacheAuthenticatedUser(service) {
  if (!service || typeof service.fetchAuthenticatedUser !== 'function') return service;
  const fetch = service.fetchAuthenticatedUser.bind(service);
  service.fetchAuthenticatedUser = (id) =>
    getReadCache().get(`authenticated-user:${id}`, async () => stripUserSecrets(await fetch(id)), {
      tables: userTables(),
      // nobody to keep: a missing user is answered by the database each time
      keep: (user) => Boolean(user),
    });
  return service;
}

module.exports = { cacheAuthenticatedUser };
