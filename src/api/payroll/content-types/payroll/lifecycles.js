'use strict';
/* global strapi */

/**
 * payroll lifecycles (v5). Ported from v3 api/payroll/models/payroll.js.
 * Defaults the bank account to the payroll account when not provided.
 */
module.exports = {
  async beforeCreate(event) {
    const me = await strapi.documents('api::me.me').findFirst();
    if (me && me.bank_account_payroll && !event.data.bank_account) {
      event.data.bank_account = me.bank_account_payroll;
    }
  },
};
