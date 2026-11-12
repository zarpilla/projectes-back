'use strict';

/**
 * The automatic monthly invoicing (issues/430), for the office: its state
 * (next run, project, last runs), a preview of a month (nothing written) and a
 * run by hand. The `01-` prefix: before the core `/:id` routes.
 */
module.exports = {
  routes: [
    { method: 'GET', path: '/auto-invoicing/status', handler: 'auto-invoicing-run.status', config: { policies: ['global::isAdminOrOffice'] } },
    { method: 'POST', path: '/auto-invoicing/preview', handler: 'auto-invoicing-run.preview', config: { policies: ['global::isAdminOrOffice'] } },
    { method: 'POST', path: '/auto-invoicing/run', handler: 'auto-invoicing-run.runNow', config: { policies: ['global::isAdminOrOffice'] } },
  ],
};
