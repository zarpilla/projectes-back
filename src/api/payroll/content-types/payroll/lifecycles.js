'use strict';
/* global strapi */
const { getMe } = require('../../../../services/me-settings');
const { applyPartialPayments } = require('../../../../services/partial-payments');

/**
 * payroll lifecycles (v5). Ported from v3 api/payroll/models/payroll.js.
 * Defaults the bank account to the payroll account when not provided.
 *
 * A bestreta can be paid in several goes (issues/460): `partial_payments`
 * add up to the net (`net_base`, what the person gets) and set `paid` /
 * `paid_date`, as on invoices and expenses (issues/412).
 */
const PARTIAL = { totalField: 'net_base', totalLabel: "l'import net de la bestreta" };

module.exports = {
  async beforeCreate(event) {
    const me = await getMe();
    if (me && me.bank_account_payroll && !event.params.data.bank_account) {
      event.params.data.bank_account = me.bank_account_payroll;
    }
    applyPartialPayments(event.params.data, null, PARTIAL);
  },

  async beforeUpdate(event) {
    const data = event.params.data || {};
    // only when the write touches the payments or the net
    if (data.partial_payments === undefined && data.net_base === undefined) return;
    const existing = await strapi.db.query('api::payroll.payroll').findOne({ where: event.params.where });
    applyPartialPayments(data, existing, PARTIAL);
  },
};
