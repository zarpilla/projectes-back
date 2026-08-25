'use strict';

/**
 * diet lifecycles (v5). Ported from v3 api/diet/models/diet.js via the shared
 * document-lifecycle factory (numbering + totals from lines + updatable guard).
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::diet.diet',
  entity: 'diet',
  hasLines: true,
});
