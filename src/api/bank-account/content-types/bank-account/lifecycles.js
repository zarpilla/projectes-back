'use strict';

/**
 * bank-account lifecycles (v5). Ported from v3 api/bank-accounts/models/bank-accounts.js.
 * Bank accounts must never be deleted (data integrity).
 */
const { ApplicationError } = require('@strapi/utils').errors;

module.exports = {
  async beforeDelete() {
    throw new ApplicationError('Bank accounts cannot be deleted for data integrity purposes');
  },
};
