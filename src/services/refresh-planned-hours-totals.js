'use strict';
/* global strapi */

/**
 * Startup script: recompute the stored planned hours (issues/067).
 *
 * Some projects kept a `total_estimated_hours` (and `total_original_hours`)
 * from before the current hours rules: on Arran de Terra, 9 projects of
 * 2022–23 stored 4.5–160 h more than their phase lines give. «Prev./Real
 * dedicació» now shows the hours computed from the lines, so the projects
 * panel must show the same.
 *
 * Every project with planned-hours lines (current or original plan) is marked
 * dirty; the totals cron (config/cron.js) recomputes them in the background.
 * Idempotent: a dirty project is only recomputed from source data.
 */
const PROJECT = 'api::project.project';

const withHours = { incomes: { estimated_hours: { id: { $notNull: true } } } };

async function refreshPlannedHoursTotals() {
  const projects = await strapi.db.query(PROJECT).findMany({
    where: { $or: [{ project_phases: withHours }, { project_original_phases: withHours }] },
    select: ['id'],
  });
  const ids = projects.map((p) => p.id);
  if (ids.length) {
    await strapi.db.connection('projects').whereIn('id', ids).update({ dirty: true });
  }
  strapi.log.info(`[refreshPlannedHoursTotals] ${ids.length} projects with planned hours marked dirty`);
}

module.exports = { refreshPlannedHoursTotals };
