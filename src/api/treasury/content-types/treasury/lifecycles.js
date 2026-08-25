'use strict';
/* global strapi */

/**
 * treasury lifecycles (v5). Ported from v3 api/treasury/models/treasury.js.
 * Defaults the bank account to the org default when not provided.
 */
module.exports = {
  async beforeCreate(event) {
    const me = await strapi.documents('api::me.me').findFirst();
    if (me && me.bank_account_default && !event.data.bank_account) {
      event.data.bank_account = me.bank_account_default;
    }
  },
};
