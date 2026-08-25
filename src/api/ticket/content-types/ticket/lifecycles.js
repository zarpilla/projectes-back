'use strict';

/**
 * ticket lifecycles (v5). Ported from v3 api/ticket/models/ticket.js via the shared
 * document-lifecycle factory.
 */
const { createDocumentLifecycles } = require('../../../../services/document-lifecycle');

module.exports = createDocumentLifecycles({
  uid: 'api::ticket.ticket',
  entity: 'ticket',
  hasLines: true,
});
