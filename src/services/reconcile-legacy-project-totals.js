'use strict';
/* global strapi */

/**
 * After the move of the stored totals to project_totals (issues/328): what the
 * old backend wrote to the old columns of `projects` during the deploy.
 *
 * A blue/green deploy keeps the previous backend serving for a few minutes
 * after the new one copied the totals (database/migrations). Meanwhile the old
 * one still marks projects dirty and its cron rewrites totals, both in the old
 * columns of `projects`, which the new code no longer reads. Run once, some
 * minutes after the boot (src/index.js): a project whose old `dirty` is set or
 * whose old totals differ from project_totals is marked dirty, and the totals
 * cron recomputes it from the source data. Nothing to do when the old columns
 * are gone (a new tenant, or after the release that drops them).
 */

const { TABLE, COLUMNS, markDirty } = require('../api/project/services/project-totals');

async function legacyColumns(knex) {
  const [rows] = await knex.raw(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['projects'],
  );
  const present = new Set(rows.map((r) => r.c));
  return COLUMNS.filter((c) => present.has(c));
}

async function reconcileLegacyProjectTotals() {
  const knex = strapi.db.connection;
  const columns = await legacyColumns(knex);
  if (!columns.length) return { marked: 0, legacy: false };
  const differs = columns
    .filter((c) => c !== 'dirty')
    .map((c) => `NOT (p.\`${c}\` <=> t.\`${c}\`)`);
  if (columns.includes('dirty')) differs.push('p.`dirty` = 1');
  const [rows] = await knex.raw(
    `SELECT p.id FROM projects p LEFT JOIN \`${TABLE}\` t ON t.project_id = p.id
      WHERE t.project_id IS NULL OR ${differs.join(' OR ')}`,
  );
  const marked = await markDirty(rows.map((r) => r.id));
  strapi.log.info(`[reconcileLegacyProjectTotals] ${marked} projects changed in the old columns marked dirty`);
  return { marked, legacy: true };
}

module.exports = { reconcileLegacyProjectTotals };
