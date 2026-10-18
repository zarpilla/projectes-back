'use strict';

/**
 * certificate routes (v5): the AEAT (`verifactu`) and FACe (`face`)
 * certificates, managed from the app (ticket 159). Admin only.
 *
 * This API has no content-type: the certificates live on the `verifactu` and
 * `me` single types (services/certificates.js).
 */
const config = {
  auth: { strategy: 'users-permissions' },
  policies: ['global::isAdmin'],
};

module.exports = {
  routes: [
    { method: 'GET', path: '/certificates/:kind', handler: 'certificate.status', config },
    // multipart: `file` (.p12/.pfx) and `password`
    { method: 'POST', path: '/certificates/:kind', handler: 'certificate.replace', config },
    { method: 'DELETE', path: '/certificates/:kind', handler: 'certificate.remove', config },
  ],
};
