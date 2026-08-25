'use strict';

/**
 * received-grant lifecycles (v5). Ported from v3 api/received-grant/models/received-grant.js
 * via the shared document-lifecycle factory (base-field totals).
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::received-grant.received-grant',
  entity: 'received-grant',
  hasLines: false,
});
