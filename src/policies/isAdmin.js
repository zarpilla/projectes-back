'use strict';

/**
 * `isAdmin` policy — ported from v3 config/policies/isAdmin.js.
 *
 * Checks that the authenticated user has the custom 'admin' permission stored in the
 * repeatable `permissions` component on the users-permissions User content type
 * (component: permissions.application-permission). This is an application-level
 * permission, distinct from Strapi's RBAC roles.
 *
 * v5 policy signature: (policyContext, config, { strapi }). A Strapi 5 policy
 * context has no ctx.forbidden()/ctx.unauthorized() (calling them answered 500,
 * issues/025): refuse by throwing, PolicyError → 403, UnauthorizedError → 401.
 */
const { errors } = require('@strapi/utils');
const { isAppAdmin } = require('../services/app-permissions');

module.exports = async (policyContext) => {
  const user = policyContext.state && policyContext.state.user;
  if (!user) {
    throw new errors.UnauthorizedError('You must be authenticated to access this resource');
  }
  if (!(await isAppAdmin(user.id))) {
    throw new errors.PolicyError('You do not have admin privileges');
  }
  return true;
};
