'use strict';
/* global strapi */
const { getMe } = require('../../../../services/me-settings');

/**
 * payroll lifecycles (v5). Ported from v3 api/payroll/models/payroll.js.
 * Defaults the bank account to the payroll account when not provided.
 */
module.exports = {
  async beforeCreate(event) {
    const me = await getMe();
    if (me && me.bank_account_payroll && !event.params.data.bank_account) {
      event.params.data.bank_account = me.bank_account_payroll;
    }
  },
};
