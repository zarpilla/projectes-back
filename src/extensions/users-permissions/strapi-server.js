'use strict';

/**
 * users-permissions plugin extension.
 *
 * Only users with the app `admin` permission may create or update users
 * (issues/020). The Authenticated role needs `user.create`/`user.update` for
 * #/admin/users, and the plugin's controllers don't restrict what is set, so
 * without this any worker could PUT /api/users/<own id> and give themselves
 * `admin`, change their role, or unblock someone.
 */
const { errors } = require('@strapi/utils');
const { isAppAdmin } = require('../../services/app-permissions');

module.exports = (plugin) => {
  const adminOnly = (action) => async (ctx, ...rest) => {
    const user = ctx.state && ctx.state.user;
    if (!user || !(await isAppAdmin(user.id))) {
      throw new errors.ForbiddenError('Only administrators can create or change users');
    }
    return action(ctx, ...rest);
  };

  const { user } = plugin.controllers;
  user.create = adminOnly(user.create);
  user.update = adminOnly(user.update);
  return plugin;
};
