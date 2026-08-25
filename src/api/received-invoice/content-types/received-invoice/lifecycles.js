'use strict';

/**
 * received-invoice lifecycles (v5). Ported from v3 api/received-invoice/models/received-invoice.js (identical trio)
 * via the shared document-lifecycle factory: payment-method defaulting,
 * contact_info denormalization, serie numbering, line totals, updatable guard.
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::received-invoice.received-invoice',
  entity: 'received-invoice',
  hasLines: true,
  withPaymentMethod: true,
  withContactInfo: true,
  skipTotalsOnInternal: true,
});
