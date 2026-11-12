'use strict';

/**
 * auto-invoicing-run controller (issues/430): the state of the automatic
 * monthly invoicing, a preview of a month and a run by hand.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const monthly = require('../../../services/monthly-invoicing/run');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthOf = (ctx) => {
  const body = ctx.request.body || {};
  const month = (body.data && body.data.month) || body.month;
  return MONTH.test(String(month || '')) ? String(month) : null;
};

module.exports = createCoreController('api::auto-invoicing-run.auto-invoicing-run', () => ({
  async status() {
    return monthly.status();
  },

  async preview(ctx) {
    const month = monthOf(ctx);
    if (!month) return ctx.badRequest('Cal indicar el mes (AAAA-MM).');
    return monthly.run({ month, preview: true });
  },

  async runNow(ctx) {
    const month = monthOf(ctx);
    if (!month) return ctx.badRequest('Cal indicar el mes (AAAA-MM).');
    try {
      return await monthly.run({ month, trigger: 'manual', user: ctx.state.user });
    } catch (error) {
      if (error.status === 409) return ctx.conflict(error.message);
      throw error;
    }
  },
}));
