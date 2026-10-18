'use strict';

/**
 * `isAdminOrOffice` policy (issues/159): like `isAdmin`, but the logistics
 * office (`orders_admin`) passes too. For what the office keeps itself in
 * Taules auxiliars › Logística (route rates) and the tables' metadata, which
 * the controller narrows to the logistics tables for her.
 */
const { errors } = require('@strapi/utils');
const { hasAppPermission } = require('../services/app-permissions');

module.exports = async (policyContext) => {
  const user = policyContext.state && policyContext.state.user;
  if (!user) {
    throw new errors.UnauthorizedError('You must be authenticated to access this resource');
  }
  if (!(await hasAppPermission(user.id, 'admin')) && !(await hasAppPermission(user.id, 'orders_admin'))) {
    throw new errors.PolicyError('You do not have admin privileges');
  }
  return true;
};
