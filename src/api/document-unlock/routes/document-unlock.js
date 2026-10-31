'use strict';

/**
 * «Desbloqueja»: turns «Modificable» back on for a received document (invoice,
 * expense, income, ticket, diet, grant). App admins only.
 */
module.exports = {
  routes: [
    {
      method: 'PUT',
      path: '/document-unlock/:type/:id',
      handler: 'document-unlock.unlock',
      config: { policies: ['global::isAdmin'] },
    },
  ],
};
