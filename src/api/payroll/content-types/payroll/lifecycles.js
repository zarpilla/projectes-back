'use strict';
/* global strapi */
const { getMe } = require('../../../../services/me-settings');
const { applyPartialPayments, storedPayments, splitPayments } = require('../../../../services/partial-payments');

/**
 * payroll lifecycles (v5). Ported from v3 api/payroll/models/payroll.js.
 * Defaults the bank account to the payroll account when not provided.
 *
 * A bestreta can be paid in several goes (issues/460): `partial_payments`
 * add up to the net (`net_base`, what the person gets) and set `paid` /
 * `paid_date`, as on invoices and expenses (issues/412). With payments, a
 * plain «paid» from Bestretes' «Paga» adds what is pending as the last one.
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
    if (data.partial_payments === undefined && data.net_base === undefined && data.paid === undefined) return;
    const existing = await strapi.db.query('api::payroll.payroll').findOne({ where: event.params.where });
    // «Paga» of Bestretes ({ paid: true, paid_date }) on one paid in part:
    // what is still pending becomes the last payment, on that day
    const stored = storedPayments(existing);
    if (data.paid === true && data.partial_payments === undefined && stored.length) {
      const split = splitPayments({ ...existing, net_base: data.net_base !== undefined ? data.net_base : existing.net_base }, 'net_base');
      if (split && split.pending) {
        const date = String(data.paid_date || new Date().toISOString()).substring(0, 10);
        data.partial_payments = [...stored, { date, amount: split.pending }];
      }
    }
    if (data.partial_payments === undefined && data.net_base === undefined && !stored.length) return;
    applyPartialPayments(data, existing, PARTIAL);
  },
};
