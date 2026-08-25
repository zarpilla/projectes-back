'use strict';

/**
 * received-expense lifecycles (v5). Ported from v3 api/received-expense/models/received-expense.js (identical trio)
 * via the shared document-lifecycle factory: payment-method defaulting,
 * contact_info denormalization, serie numbering, line totals, updatable guard.
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::received-expense.received-expense',
  entity: 'received-expense',
  hasLines: true,
  withPaymentMethod: true,
  withContactInfo: true,
  skipTotalsOnInternal: true,
});
