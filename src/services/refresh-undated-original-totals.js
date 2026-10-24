'use strict';
/* global strapi */

const { markDirty } = require('../api/project/services/project-totals');

/**
 * Startup script: recompute the Original totals of projects with undated
 * original-budget lines (issues/195).
 *
 * The undated (9999) year bucket was dropped when only its original totals
 * were non-zero, so those lines never reached `total_original_*`: 68 projects
 * on Resilience stored 0 or a stale figure. Every project with an original
 * income or expense line without date is marked dirty; the totals cron
 * (config/cron.js) recomputes them in the background. Idempotent.
 */
const PROJECT = 'api::project.project';

const undated = { date: { $null: true }, date_estimate_document: { $null: true } };

async function refreshUndatedOriginalTotals() {
  const projects = await strapi.db.query(PROJECT).findMany({
    where: {
      $or: [{ project_original_phases: { incomes: undated } }, { project_original_phases: { expenses: undated } }],
    },
    select: ['id'],
  });
  const ids = projects.map((p) => p.id);
  if (ids.length) {
    await markDirty(ids);
  }
  strapi.log.info(`[refreshUndatedOriginalTotals] ${ids.length} projects with undated original lines marked dirty`);
}

module.exports = { refreshUndatedOriginalTotals };
