'use strict';

const { buildSingleProjectActivitiesMap } = require('./projectFinancials');

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

module.exports = { activitiesByProjectMonth };
