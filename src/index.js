'use strict';

const { importSeedPermissions, importSeedRows } = require('./services/bootstrap-permissions');

module.exports = {
  /**
   * An asynchronous register function that runs before your application is
   * initialized. Used to register hooks, services, etc.
   */
  register(/* { strapi } */) {
    // Nothing to register yet.
  },

  /**
   * An asynchronous bootstrap function that runs before your application gets
   * started.
   *
   * Ported from the v3 config/functions/bootstrap.js (3,897 LOC):
   *  - P6.1: the public/authenticated permission matrix (importSeedPermissions)
   *  - P6.3: seed rows — verifactu settings, declarations, default bank account
   *  - P6.2: the 14 v3 runOnce backfills are NOT re-implemented here — they are
   *    one-time data migrations and belong to the Phase 7 ETL (the clean-room
   *    build loads already-corrected data). The v3 startup-scripts guard
   *    pattern is therefore unnecessary in v5.
   */
  async bootstrap({ strapi }) {
    try {
      await importSeedPermissions();
      await importSeedRows();
      strapi.log.info('[bootstrap] permissions + seed rows ready');
    } catch (error) {
      strapi.log.error(`[bootstrap] failed: ${error && error.message}`);
    }
  },
};
