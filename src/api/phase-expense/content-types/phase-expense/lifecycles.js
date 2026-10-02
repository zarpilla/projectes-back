'use strict';
/* global strapi */

/**
 * phase-expense lifecycles (v5). Ported from v3 api/phase-expense/models/phase-expense.js.
 * Marks affected projects dirty for the totals-refresh queue (P4.10 scheduler).
 */
const {
  projectIdsForPhaseRows,
  scheduleFromPhaseRows,
} = require('../../../project/services/totalsRefreshScheduler');

const UID = 'api::phase-expense.phase-expense';

async function rememberProjects(event) {
  event.state.previousProjectIds = await projectIdsForPhaseRows(UID, event.params.where);
}

async function scheduleRemembered(event) {
  await scheduleFromPhaseRows(UID, null, event.state.previousProjectIds || []);
}

module.exports = {
  async afterCreate(event) {
    await scheduleFromPhaseRows(UID, { id: event.result.id });
  },
  // An update can move the row to another phase (or project): remember the
  // project(s) it belonged to so both old and new get recomputed.
  beforeUpdate: rememberProjects,
  async afterUpdate(event) {
    const where = event.result ? { id: event.result.id } : event.params.where;
    await scheduleFromPhaseRows(UID, where, event.state.previousProjectIds || []);
  },
  // After delete the links are gone, so resolve the projects beforehand.
  // updatePhases removes rows with deleteMany, hence the *Many hooks.
  beforeDelete: rememberProjects,
  afterDelete: scheduleRemembered,
  beforeDeleteMany: rememberProjects,
  afterDeleteMany: scheduleRemembered,
};
