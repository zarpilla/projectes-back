'use strict';
/* global strapi */

/**
 * A user who has activities, payrolls or work periods can't be deleted.
 *
 * Ported from v3's User model lifecycles, which lived in
 * extensions/users-permissions/content-types/user/lifecycles.js: Strapi 5 never
 * loads a lifecycles file from a plugin extension, so the guard didn't run and a
 * user with payrolls could be deleted. Their payrolls then pointed at nobody and
 * GET /treasuries/forecast answered 500 (issues/050). Subscribed from bootstrap()
 * for every way a user is deleted (db query, document service, the plugin's
 * DELETE /api/users/:id).
 */
const { errors } = require('@strapi/utils');

const USER = 'plugin::users-permissions.user';

const CHECKS = [
  { uid: 'api::activity.activity', label: 'hores dedicades' },
  { uid: 'api::payroll.payroll', label: 'nòmines' },
  { uid: 'api::daily-dedication.daily-dedication', label: 'jornades' },
];

async function guardUserDelete(event) {
  const where = event && event.params && event.params.where;
  if (!where) return;
  const users = await strapi.db.query(USER).findMany({ where, select: ['id', 'username'] });

  for (const user of users) {
    for (const { uid, label } of CHECKS) {
      const count = await strapi.db.query(uid).count({ where: { users_permissions_user: user.id } });
      if (count > 0) {
        throw new errors.ApplicationError(
          `No es pot esborrar la persona "${user.username}": té ${count} ${label}. Reassigna-les o esborra-les abans.`,
        );
      }
    }
  }
}

function registerUserDeleteGuard() {
  strapi.db.lifecycles.subscribe({
    models: [USER],
    beforeDelete: guardUserDelete,
    beforeDeleteMany: guardUserDelete,
  });
}

module.exports = { guardUserDelete, registerUserDeleteGuard };
