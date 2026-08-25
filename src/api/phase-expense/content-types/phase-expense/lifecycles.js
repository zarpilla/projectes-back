'use strict';
/* global strapi */

/**
 * phase-expense lifecycles (v5). Ported from v3 api/phase-expense/models/phase-expense.js.
 * Marks affected projects dirty for the totals-refresh queue (P4.10 scheduler).
 */
const { scheduleFromPhaseRow } = require('../../../project/services/totalsRefreshScheduler');

module.exports = {
  async afterCreate(event) {
    await scheduleFromPhaseRow(event.result);
  },
  async afterUpdate(event) {
    await scheduleFromPhaseRow(event.result);
    // If project_phase was reassigned the previous project is reachable
    // only via the update payload; schedule it too so the old project is recomputed.
    const data = event.params.data;
    if (data && (data.project_phase || data.project_original_phase)) {
      await scheduleFromPhaseRow(data);
    }
  },
  async beforeDelete(event) {
    const row = await strapi.db
      .query('api::phase-expense.phase-expense')
      .findOne({ where: event.params.where });
    await scheduleFromPhaseRow(row);
  },
};
