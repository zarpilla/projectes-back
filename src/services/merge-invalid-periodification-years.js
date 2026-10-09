'use strict';
/* global strapi */

/**
 * Startup script: fold the periodification rows saved with a junk year
 * ("Invalid date", empty…) into the project's undated "9999" row.
 *
 * Until issues/015, a line with no date was bucketed under moment's
 * "Invalid date" year, and the form saved that year into the project's
 * periodification. Undated lines now always go to UNDATED_YEAR, so those
 * rows would sit next to it as a second, unexplained undated row.
 *
 * Each junk row is renamed to UNDATED_YEAR, or, when the project already has
 * one, its amounts are added to it and the junk row is removed. Project totals
 * sum every year, so they don't change and nothing is marked dirty.
 */
const { UNDATED_YEAR } = require('../api/project/services/projectFinancials');

const TABLE = 'components_periodification_periodifications';
const LINKS = 'projects_cmps';
const COMPONENT = 'periodification.periodification';
const AMOUNTS = ['incomes', 'expenses', 'real_incomes', 'real_expenses'];

const isRealYear = (year) => /^\d{4}$/.test(String(year || '').trim());

async function mergeInvalidPeriodificationYears() {
  const knex = strapi.db.connection;
  const rows = await knex(TABLE)
    .join(LINKS, `${LINKS}.cmp_id`, `${TABLE}.id`)
    .where(`${LINKS}.component_type`, COMPONENT)
    .select(`${TABLE}.*`, `${LINKS}.entity_id as project_id`);

  const byProject = new Map();
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push(row);
  }

  let renamed = 0;
  let merged = 0;
  for (const [projectId, projectRows] of byProject) {
    const junk = projectRows.filter((r) => !isRealYear(r.year));
    if (!junk.length) continue;

    let target = projectRows.find((r) => String(r.year).trim() === UNDATED_YEAR);
    for (const row of junk) {
      if (!target) {
        await knex(TABLE).where({ id: row.id }).update({ year: UNDATED_YEAR });
        target = { ...row, year: UNDATED_YEAR };
        renamed++;
        continue;
      }
      const sums = {};
      for (const f of AMOUNTS) {
        sums[f] = (Number(target[f]) || 0) + (Number(row[f]) || 0);
      }
      await knex(TABLE).where({ id: target.id }).update(sums);
      Object.assign(target, sums);
      await knex(LINKS).where({ cmp_id: row.id, component_type: COMPONENT }).del();
      await knex(TABLE).where({ id: row.id }).del();
      merged++;
    }
    strapi.log.info(`[mergeInvalidPeriodificationYears] project ${projectId}: ${junk.length} row(s) fixed`);
  }

  strapi.log.info(
    `[mergeInvalidPeriodificationYears] renamed ${renamed}, merged ${merged} periodification row(s)`,
  );
}

module.exports = { mergeInvalidPeriodificationYears, isRealYear };
