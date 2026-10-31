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
 *
 * Every new password must meet services/password-policy (10 characters, not a
 * common one, not the person's or entity's name): the reset link, changing
 * one's own, register, and an admin creating or editing a user. An admin's
 * change also ends the user's other sessions, as the plugin already does for
 * the other two. A login with a password that doesn't meet it answers
 * `passwordWeak: true`, and the front suggests changing it.
 */
const { errors } = require('@strapi/utils');
const { isAppAdmin } = require('../../services/app-permissions');
const { cachePermissionReads } = require('../../services/role-permissions-cache');
const { cacheAuthenticatedUser } = require('../../services/authenticated-user-cache');
const userHome = require('../../services/user-home');
const { passwordProblem, contextFor } = require('../../services/password-policy');

const USER = 'plugin::users-permissions.user';

const findUser = (where) => global.strapi.db.query(USER).findOne({ where });

/** Throws the policy's message when `password` doesn't meet it. */
async function assertPasswordOk(password, user) {
  const problem = passwordProblem(password, await contextFor(user));
  if (problem) throw new errors.ValidationError(problem);
}

const isNewPassword = (body) => !!body && typeof body.password === 'string' && body.password !== '';

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

  const { create, update } = user;
  user.create = adminOnly(async (ctx, ...rest) => {
    const body = ctx.request && ctx.request.body;
    if (isNewPassword(body)) await assertPasswordOk(body.password, body);
    return create(ctx, ...rest);
  });
  user.update = adminOnly(async (ctx, ...rest) => {
    const body = ctx.request && ctx.request.body;
    if (!isNewPassword(body)) return update(ctx, ...rest);
    const id = ctx.params && ctx.params.id;
    const current = (await findUser({ id })) || {};
    await assertPasswordOk(body.password, { ...current, ...body });
    const result = await update(ctx, ...rest);
    // the user's other sessions end, as after a reset; not the admin's own
    if (String(id) !== String(ctx.state.user.id)) {
      try {
        await global.strapi.sessionManager('users-permissions').invalidateRefreshToken(String(id));
      } catch (error) {
        global.strapi.log.warn(`[users] could not end the sessions of user ${id}: ${error.message}`);
      }
    }
    return result;
  });
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
    const { forgotPassword, resetPassword, changePassword, register, callback } = auth;
    auth.forgotPassword = async (ctx, ...rest) => {
      const body = ctx.request && ctx.request.body;
      if (body && typeof body === 'object') delete body.url;
      return forgotPassword(ctx, ...rest);
    };

    auth.resetPassword = async (ctx, ...rest) => {
      const body = ctx.request && ctx.request.body;
      // a wrong code is left to the plugin («Incorrect code provided»)
      if (isNewPassword(body) && typeof body.code === 'string' && body.code) {
        const owner = await findUser({ resetPasswordToken: body.code });
        if (owner) await assertPasswordOk(body.password, owner);
      }
      return resetPassword(ctx, ...rest);
    };

    auth.changePassword = async (ctx, ...rest) => {
      const body = ctx.request && ctx.request.body;
      const me = ctx.state && ctx.state.user;
      if (isNewPassword(body) && me) {
        await assertPasswordOk(body.password, (await findUser({ id: me.id })) || me);
      }
      return changePassword(ctx, ...rest);
    };

    auth.register = async (ctx, ...rest) => {
      const body = ctx.request && ctx.request.body;
      if (isNewPassword(body)) await assertPasswordOk(body.password, body);
      return register(ctx, ...rest);
    };

    // a successful login says whether the password meets the policy
    auth.callback = async (ctx, ...rest) => {
      const params = (ctx.request && ctx.request.body) || {};
      const password = params.password;
      const result = await callback(ctx, ...rest);
      const answer = ctx.body;
      if (typeof password === 'string' && answer && answer.jwt && answer.user && answer.user.id) {
        try {
          const row = await findUser({ id: answer.user.id });
          answer.passwordWeak = !!passwordProblem(password, await contextFor(row || answer.user));
        } catch (error) {
          global.strapi.log.warn(`[auth] password check on login failed: ${error.message}`);
        }
      }
      return result;
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
