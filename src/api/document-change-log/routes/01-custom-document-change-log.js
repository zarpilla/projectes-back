'use strict';

/**
 * document-change-log custom routes (issues/161). `01-` so the core
 * `/document-change-logs/:id` does not shadow it.
 */
module.exports = {
  routes: [
    // one record's history, newest first: ?start=0&limit=50
    {
      method: 'GET',
      path: '/document-change-logs/history/:entity/:id',
      handler: 'document-change-log.history',
    },
  ],
};
