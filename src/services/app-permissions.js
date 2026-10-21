'use strict';

/**
 * App-level permissions ("projects", "hours", "orders", "admin"...), stored in
 * the repeatable `permissions` component of the users-permissions user. They
 * are distinct from Strapi's roles: every app user has the Authenticated role.
 *
 * Read on every request (middlewares/app-permissions.js), so they are kept in
 * the read cache per user (issues/307): dropped as soon as the user, her
 * permissions component or its link change (in this process at once, from
 * another process within the stamps' few seconds).
 */

const { getReadCache } = require('./read-cache');

const USER = 'plugin::users-permissions.user';

/** The users table: declared so its stamps are read before the first load. */
function userTables(app) {
  try {
    const meta = app.db.metadata.get(USER);
    return meta && meta.tableName ? [meta.tableName] : [];
  } catch {
    return [];
  }
}

/** The app permissions of the user with this id, e.g. ['projects', 'hours']. */
async function appPermissionsOf(userId, app = global.strapi) {
  if (!userId) return [];
  return getReadCache().get(
    `app-permissions:${userId}`,
    async () => {
      const user = await app.db
        .query(USER)
        .findOne({ where: { id: userId }, populate: { permissions: true } });
      return ((user && user.permissions) || []).map((p) => p && p.permission).filter(Boolean);
    },
    { tables: userTables(app) },
  );
}

/** Whether the user with this id has the app permission `permission`. */
async function hasAppPermission(userId, permission) {
  if (!userId) return false;
  return (await appPermissionsOf(userId)).includes(permission);
}

const isAppAdmin = (userId) => hasAppPermission(userId, 'admin');

module.exports = { appPermissionsOf, hasAppPermission, isAppAdmin };
