'use strict';

/**
 * received-income lifecycles (v5). Ported from v3 api/received-income/models/received-income.js (identical trio)
 * via the shared document-lifecycle factory: payment-method defaulting,
 * contact_info denormalization, serie numbering, line totals, updatable guard.
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::received-income.received-income',
  entity: 'received-income',
  hasLines: true,
  withPaymentMethod: true,
  withContactInfo: true,
  skipTotalsOnInternal: true,
});
