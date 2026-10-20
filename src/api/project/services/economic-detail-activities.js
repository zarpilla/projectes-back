'use strict';
/* global strapi */

const { buildSingleProjectActivitiesMap, UNDATED_YEAR } = require('./projectFinancials');

const ACTIVITY = 'api::activity.activity';

/**
 * The executed hours of findWithEconomicDetail, per project and month:
 * Map(projectId → [{ projectId, year, month, hours, cost }]), the shape the
 * single-project form builds with buildSingleProjectActivitiesMap.
 *
 * The activities come populated under their project, so they carry no
 * `project` of their own; they were filtered on `a.project` and every one was
 * dropped, so «Hores exec» was always 0 € (issues/060). Each project's
 * activities are grouped under that project's id. Undated ones go to the
 * undated (9999) bucket, as in the project form; they were left out, so the
 * report had fewer hours than the form (issues/205).
 */
function activitiesByProjectMonth(projects) {
  const byProject = new Map();
  (projects || []).forEach((p) => {
    const activities = p.activities || [];
    if (activities.length) {
      byProject.set(p.id, buildSingleProjectActivitiesMap(p.id, activities).get(p.id));
    }
  });
  return byProject;
}

/**
 * Same result as activitiesByProjectMonth, summed by the database
 * (issues/309): the report loaded every activity with all its columns
 * (40.000 rows on resilience, the slowest query of the report) only to add
 * up hours and cost per month.
 *
 * @param {number[]} projectIds
 * @returns {Promise<Map<number, Array<{projectId, year, month, hours, cost}>>>}
 */
async function loadActivitiesByProjectMonth(projectIds) {
  const byProject = new Map();
  if (!projectIds || !projectIds.length) return byProject;

  const meta = strapi.db.metadata.get(ACTIVITY);
  const { joinTable } = meta.attributes.project;
  const activityColumn = joinTable.joinColumn.name;
  const projectColumn = joinTable.inverseJoinColumn.name;
  const knex = strapi.db.connection;

  const rows = await knex(`${meta.tableName} as a`)
    .join(`${joinTable.name} as l`, `l.${activityColumn}`, 'a.id')
    .whereIn(`l.${projectColumn}`, projectIds)
    .groupBy(`l.${projectColumn}`, knex.raw('YEAR(a.date)'), knex.raw('MONTH(a.date)'))
    .select(
      `l.${projectColumn} as project_id`,
      knex.raw('YEAR(a.date) as y'),
      knex.raw('MONTH(a.date) as m'),
      knex.raw('SUM(a.hours) as hours'),
      knex.raw('SUM(COALESCE(a.hours, 0) * COALESCE(a.cost_by_hour, 0)) as cost'),
    );

  for (const r of rows) {
    const projectId = Number(r.project_id);
    const undated = r.y == null;
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId).push({
      projectId,
      year: undated ? Number(UNDATED_YEAR) : Number(r.y),
      month: undated ? 12 : Number(r.m),
      cost: Number(r.cost) || 0,
      hours: r.hours == null ? r.hours : Number(r.hours),
    });
  }
  return byProject;
}

module.exports = { activitiesByProjectMonth, loadActivitiesByProjectMonth };
