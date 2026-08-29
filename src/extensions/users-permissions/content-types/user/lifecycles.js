'use strict';
/* global strapi */

/**
 * users-permissions User lifecycles (v5). Ported from v3 extensions/users-permissions/models/User.js.
 * Prevents deleting users with associated activities, payrolls, or daily dedications.
 */
module.exports = {
  async beforeDelete(event) {
    const id = event.params.where.id;

    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id } });
    if (!user) return;

    const checks = [
      { uid: 'api::activity.activity', label: 'activities' },
      { uid: 'api::payroll.payroll', label: 'payroll records' },
      { uid: 'api::daily-dedication.daily-dedication', label: 'daily dedication records' },
    ];

    for (const { uid, label } of checks) {
      const exists = await strapi.db.query(uid).findMany({
        where: { users_permissions_user: id },
        limit: 1,
      });
      if (exists.length > 0) {
        const count = await strapi.db.query(uid).count({
          where: { users_permissions_user: id },
        });
        throw new Error(
          `Cannot delete user "${user.username}" because they have ${count} associated ${label}. Please reassign or delete them first.`,
        );
      }
    }
  },

  async beforeUpdate(event) {
    // Intentionally empty (v3 parity): blocking-users-with-activities guard is
    // documented but disabled in v3.
  },
};
