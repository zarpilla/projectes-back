'use strict';

const { importSeedPermissions, importSeedRows } = require('./services/bootstrap-permissions');
const { runStartupScript } = require('./services/startup-scripts');
const { recalcZeroDocumentTotals } = require('./services/recalc-zero-document-totals');

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
   *    build loads already-corrected data).
   *  - v5 data fixes: one-time repairs of rows written wrongly by v5 itself,
   *    through the ported v3 startup-scripts guard (services/startup-scripts).
   */
  async bootstrap({ strapi }) {
    try {
      await importSeedPermissions();
      await importSeedRows();
      strapi.log.info('[bootstrap] permissions + seed rows ready');
    } catch (error) {
      strapi.log.error(`[bootstrap] failed: ${error && error.message}`);
    }

    // Kept apart from the seed block: a failed data fix must not read as a
    // failed permission seed, nor stop the next fix from running.
    const fixes = [['recalcZeroDocumentTotals', recalcZeroDocumentTotals]];
    for (const [name, handler] of fixes) {
      try {
        await runStartupScript(name, handler, { runOnce: true });
      } catch (error) {
        strapi.log.error(`[bootstrap] startup script ${name} failed: ${error && error.message}`);
      }
    }
  },
};
