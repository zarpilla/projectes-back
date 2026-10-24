'use strict';
/* global strapi */

const { markDirty } = require('../api/project/services/project-totals');

/**
 * Startup script: recompute the stored totals of projects with «Total»
 * planned-hours lines (issues/259).
 *
 * A «Total» line was split by whole months, so a range shorter than about
 * half a month produced no per-day rows and its hours and cost were missing
 * from the stored project totals (Arran de Terra «Jordania»: 112 h), and
 * longer ones were piled into their first months. The engine now spreads the
 * line over its working days. Every project with a «Total» line (or one
 * without type, which the engine treats as «Total»), in the current or the
 * original plan, is marked dirty; the totals cron (config/cron.js) recomputes
 * them in the background. Idempotent: a dirty project is only recomputed from
 * source data.
 */
const PROJECT = 'api::project.project';

const withTotalHours = {
  incomes: {
    estimated_hours: { $or: [{ quantity_type: 'total' }, { quantity_type: { $null: true } }] },
  },
};

async function refreshTotalHoursTotals() {
  const projects = await strapi.db.query(PROJECT).findMany({
    where: { $or: [{ project_phases: withTotalHours }, { project_original_phases: withTotalHours }] },
    select: ['id'],
  });
  const ids = projects.map((p) => p.id);
  if (ids.length) {
    await markDirty(ids);
  }
  strapi.log.info(`[refreshTotalHoursTotals] ${ids.length} projects with «Total» planned hours marked dirty`);
}

module.exports = { refreshTotalHoursTotals };
