'use strict';

/**
 * `isAdmin` policy — ported from v3 config/policies/isAdmin.js.
 *
 * Checks that the authenticated user has the custom 'admin' permission stored in the
 * repeatable `permissions` component on the users-permissions User content type
 * (component: permissions.application-permission). This is an application-level
 * permission, distinct from Strapi's RBAC roles.
 *
 * v5 policy signature: (ctx, config, { strapi }) => Promise<void>.
 * The user is loaded via strapi.db.query (component populated) since the custom
 * `permissions` component is part of the User content-type extension.
 */
module.exports = async (ctx, config, { strapi }) => {
  if (!ctx.state.user) {
    return ctx.unauthorized('You must be authenticated to access this resource');
  }

  // Load the user with their permissions component populated.
  const user = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { id: ctx.state.user.id },
    populate: { permissions: true },
  });

  if (!user) {
    return ctx.unauthorized('User not found');
  }

  const hasAdminPermission =
    Array.isArray(user.permissions) && user.permissions.some((p) => p.permission === 'admin');

  if (!hasAdminPermission) {
    return ctx.forbidden('You do not have admin privileges');
  }

  // User is admin, proceed to the next handler.
};
