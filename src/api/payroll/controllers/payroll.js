'use strict';
/* global strapi */

/**
 * payroll controller (v5). Ported from v3 api/payroll/controllers/payroll.js.
 * Custom endpoint: createAll — bulk monthly payroll generation per user/year.
 *
 * Data-access migration: strapi.query -> strapi.db.query; duplicate-prevention
 * re-query logic preserved verbatim.
 */
const moment = require('moment');
const { createCoreController } = require('@strapi/strapi').factories;

// A relation field may come back as a populated object { id }, a raw id, or null.
// Normalize to a comparable string.
const idOf = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') return value.id != null ? String(value.id) : null;
  return String(value);
};

module.exports = createCoreController('api::payroll.payroll', ({ strapi }) => ({
  /**
   * POST /api/payrolls/create-all?year=YYYY
   * Creates payrolls for every user with a daily-dedication covering each month.
   */
  async createAll(ctx) {
    const year = ctx.query.year;

    const months = await strapi.db.query('api::month.month').findMany({ limit: -1 });
    const years = await strapi.db.query('api::year.year').findMany({ limit: -1 });
    const users = await strapi.db.query('plugin::users-permissions.user').findMany({ limit: -1 });

    const userPayrollsInfo = [];

    for (const user of users) {
      const userPayrollsCreated = [];
      const userPayrollsExist = [];

      const dedications = await strapi.db
        .query('api::daily-dedication.daily-dedication')
        .findMany({ where: { users_permissions_user: user.id }, limit: -1 });

      // Populate year/month so the existence check always has {id} objects.
      const userPayrolls = await strapi.db.query('api::payroll.payroll').findMany({
        where: { users_permissions_user: user.id },
        populate: { year: true, month: true, users_permissions_user: true },
        limit: -1,
      });

      if (dedications && dedications.length) {
        for (let m = 1; m <= 12; m++) {
          const emitted = moment(`${year}-${m}-01`, 'YYYY-MM-DD').endOf('month').format('YYYY-MM-DD');

          const dedication = dedications.find((dd) => emitted >= dd.from && emitted <= dd.to);
          if (!dedication) continue;

          const month = months.find((mo) => mo.month == m);
          const y = years.find((ye) => ye.year == year);
          if (!month || !y) continue;

          const yearId = String(y.id);
          const monthId = String(month.id);

          const payrollExist = userPayrolls.find(
            (up) => idOf(up.year) === yearId && idOf(up.month) === monthId,
          );

          if (!payrollExist) {
            // Defense in depth: re-query right before insert (concurrent-run guard).
            const justCreated = await strapi.db.query('api::payroll.payroll').findOne({
              where: {
                users_permissions_user: user.id,
                year: y.id,
                month: month.id,
              },
            });
            if (justCreated) {
              userPayrollsExist.push(justCreated);
              continue;
            }

            const total = (dedication.hours / 8) * dedication.monthly_salary;

            const payroll = {
              month: month.id,
              year: y.id,
              users_permissions_user: user.id,
              total_base: total,
              total: total,
              total_irpf: 0,
              total_vat: 0,
              paid: false,
              emitted,
              net_base: 0,
              net_date: emitted,
              ss_base: dedication.pct_quota ? (total * dedication.pct_quota) / 100 : dedication.quota,
              ss_date: moment(`${year}-${m}-01`, 'YYYY-MM-DD')
                .add(1, 'month')
                .endOf('month')
                .format('YYYY-MM-DD'), // mes següent vençut
              irpf_base: dedication.pct_irpf ? (total * dedication.pct_irpf) / 100 : 0,
              irpf_date: moment(`${year}-${m}-01`, 'YYYY-MM-DD')
                .endOf('quarter')
                .add(20, 'day')
                .format('YYYY-MM-DD'),
              other_base: dedication.pct_other ? (total * dedication.pct_other) / 100 : 0,
              other_date: moment(`${year}-${m}-01`, 'YYYY-MM-DD')
                .add(1, 'month')
                .endOf('month')
                .format('YYYY-MM-DD'),
            };

            payroll.net_base =
              parseFloat(payroll.total) - parseFloat(payroll.irpf_base) - parseFloat(payroll.other_base);
            payroll.total = parseFloat(payroll.total) + parseFloat(payroll.ss_base || 0);

            const payrollDb = await strapi.db.query('api::payroll.payroll').create({
              data: { ...payroll, publishedAt: new Date() },
            });

            // Keep the snapshot in sync for later iterations in this run.
            userPayrolls.push(payrollDb);
            userPayrollsCreated.push(payrollDb);
          } else {
            userPayrollsExist.push(payrollExist);
          }
        }

        userPayrollsInfo.push({
          user: user.id,
          username: user.username,
          created: userPayrollsCreated.length,
          existing: userPayrollsExist.length,
        });
      }
    }

    return { userPayrollsInfo };
  },
}));
