'use strict';
/* global strapi */

/**
 * App-level permissions ("projects", "hours", "orders", "admin"...), stored in
 * the repeatable `permissions` component of the users-permissions user. They
 * are distinct from Strapi's roles: every app user has the Authenticated role.
 */

/** Whether the user with this id has the app permission `permission`. */
async function hasAppPermission(userId, permission) {
  if (!userId) return false;
  const user = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { id: userId },
    populate: { permissions: true },
  });
  return Boolean(
    user && Array.isArray(user.permissions) && user.permissions.some((p) => p && p.permission === permission),
  );
}

const isAppAdmin = (userId) => hasAppPermission(userId, 'admin');

module.exports = { hasAppPermission, isAppAdmin };
