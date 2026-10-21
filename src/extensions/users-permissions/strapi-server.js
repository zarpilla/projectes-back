'use strict';

/**
 * users-permissions plugin extension.
 *
 * Only users with the app `admin` permission may create or update users
 * (issues/020). The Authenticated role needs `user.create`/`user.update` for
 * #/admin/users, and the plugin's controllers don't restrict what is set, so
 * without this any worker could PUT /api/users/<own id> and give themselves
 * `admin`, change their role, or unblock someone.
 *
 * auth/forgot-password ignores a `url` in the body (issues/021): v3 fronts sent
 * the reset link's URL, which Strapi 5 refuses as an unknown key. The link now
 * comes from the `email_reset_password` setting (services/ensure-reset-password-url.js).
 *
 * The role's permissions are kept in memory between requests instead of being
 * read on each one (issues/016, services/role-permissions-cache.js), and so is
 * the authenticated user (issues/307, services/authenticated-user-cache.js).
 *
 * GET/PUT /users/me/home keep each person's Inici (pinned menu entries and the
 * page opened after login) on their own user (services/user-home.js).
 */
const { errors } = require('@strapi/utils');
const { isAppAdmin } = require('../../services/app-permissions');
const { cachePermissionReads } = require('../../services/role-permissions-cache');
const { cacheAuthenticatedUser } = require('../../services/authenticated-user-cache');
const userHome = require('../../services/user-home');

module.exports = (plugin) => {
  const adminOnly =
    (action) =>
    async (ctx, ...rest) => {
      const user = ctx.state && ctx.state.user;
      if (!user || !(await isAppAdmin(user.id))) {
        throw new errors.ForbiddenError('Only administrators can create or change users');
      }
      return action(ctx, ...rest);
    };

  const { user } = plugin.controllers;
  user.create = adminOnly(user.create);
  user.update = adminOnly(user.update);
  user.home = userHome.controllers.home;
  user.updateHome = userHome.controllers.updateHome;

  const contentApi = plugin.routes && plugin.routes['content-api'];
  if (contentApi) {
    // before the plugin's own /users/:id routes
    contentApi.routes = [...userHome.routes, ...contentApi.routes];
  }

  const authFactory = plugin.controllers.auth;
  plugin.controllers.auth = (deps) => {
    const auth = authFactory(deps);
    const { forgotPassword } = auth;
    auth.forgotPassword = async (ctx, ...rest) => {
      const body = ctx.request && ctx.request.body;
      if (body && typeof body === 'object') delete body.url;
      return forgotPassword(ctx, ...rest);
    };
    return auth;
  };

  const permissionFactory = plugin.services && plugin.services.permission;
  if (permissionFactory) {
    plugin.services.permission = (deps) => cachePermissionReads(permissionFactory(deps));
  }

  // the authenticated user and her role, kept in the read cache (issues/307)
  const userFactory = plugin.services && plugin.services.user;
  if (typeof userFactory === 'function') {
    plugin.services.user = (deps) => cacheAuthenticatedUser(userFactory(deps));
  }

  return plugin;
};
