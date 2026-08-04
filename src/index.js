'use strict';

module.exports = {
  /**
   * An asynchronous register function that runs before your application is
   * initialized. Used to register hooks, services, etc.
   *
   * Migration: v3 bootstrap permission-seeding and runOnce backfills move here
   * in Phase 6. For now this is a skeleton.
   */
  register(/* { strapi } */) {
    // TODO(P6.1): port setPermissions / importSeedData here.
  },

  /**
   * An asynchronous bootstrap function that runs before your application gets
   * started. Opportunity to set up data, run jobs, or special logic.
   *
   * Migration: v3's 3,897-line config/functions/bootstrap.js is split here —
   * runtime invariants stay, one-time backfills move to the Phase 7 ETL.
   */
  bootstrap(/* { strapi } */) {
    // TODO(P6.2/P6.3): port runtime-invariant bootstrap logic + seed-row creation.
  },
};
