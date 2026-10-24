'use strict';

/**
 * «Còpia de seguretat» (Administració): last night's dump of the entity's own
 * database, written on the host by deploy/docker/tenant-dumps.sh and mounted
 * read-only into the container. App admins only.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/backup/latest',
      handler: 'backup.latest',
      config: { policies: ['global::isAdmin'] },
    },
    {
      method: 'GET',
      path: '/backup/latest/download',
      handler: 'backup.download',
      config: { policies: ['global::isAdmin'] },
    },
  ],
};
