'use strict';

/**
 * emitted-grant lifecycles (v5). Ported from v3 api/emitted-grant/models/emitted-grant.js
 * via the shared document-lifecycle factory (base-field totals).
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::emitted-grant.emitted-grant',
  entity: 'emitted-grant',
  hasLines: false,
});
