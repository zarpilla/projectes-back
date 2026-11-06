'use strict';

/**
 * The treasury forecast's project filter (state / type / likelihood).
 *
 * Extracted from the controller because the id it compares against is the one
 * thing that changed shape between v3 and v5: v3 stored these relations as FK
 * columns, so `project.project_state` was a plain integer that was always on the
 * row. v5 omits an unpopulated relation entirely and returns an *object* once
 * populated — so the v3 comparison silently matched nothing and the whole /vat
 * page came back empty (0 projects, 0 VAT documents) with no error anywhere.
 *
 * FILTER_RELATIONS names what the caller must populate; the forecast controller
 * populates exactly these, and tests/treasury-project-filter.test.js checks it.
 */

/** Relations `filterProjects` dereferences — the caller must populate them. */
const FILTER_RELATIONS = ['project_state', 'project_type', 'project_likelihood'];

/** v5 populated relation (object) or v3 FK id (number/null) -> id. */
const relationId = (value) => (value && typeof value === 'object' ? value.id : value);

/**
 * Parses one filter param.
 *
 *   absent (undefined/null)  -> null, meaning "no filter on this field"
 *   empty string             -> [], meaning "match nothing" (all deselected)
 *   "1,3,null"               -> [1, 3, null]; `null` is the "Sense" bucket
 */
function parseIdList(raw) {
  if (raw === undefined || raw === null) return null;
  if (raw === '') return [];
  return String(raw)
    .split(',')
    .map((x) => (x === 'null' ? null : parseInt(x, 10)));
}

const inSet = (val, set) => (set === null ? true : set.includes(val));

// Some projects store a non-FK sentinel (0) instead of NULL for project_type /
// project_likelihood — legacy dirty data. Treat any falsy value as the "Sense"
// bucket so the `null` token covers them too. `project_state` keeps the v3
// behaviour of comparing the raw value, sentinel and all.
const bucket = (val) => relationId(val) || null;

/**
 * @param {object[]} projects  project rows, with FILTER_RELATIONS populated
 * @param {{states:?Array, types:?Array, likelihoods:?Array}} selected
 * @returns {object[]} the projects passing all three filters
 */
function filterProjects(projects, { states = null, types = null, likelihoods = null } = {}) {
  return (projects || []).filter(
    (p) =>
      inSet(relationId(p.project_state), states) &&
      inSet(bucket(p.project_type), types) &&
      inSet(bucket(p.project_likelihood), likelihoods),
  );
}

// a populated relation as { id, name }, or null
const namedRef = (r) => (r && r.id ? { id: r.id, name: r.name } : null);

// A project as the treasury screens list it (issues/309). Type and scope let
// Tresoreria filter by several projects, types or scopes in the browser
// (issues/416); the forecast already populates both.
const forecastProjectOption = (p) => ({
  id: p.id,
  name: p.name,
  project_state: namedRef(p.project_state),
  project_type: namedRef(p.project_type),
  project_scope: namedRef(p.project_scope),
  mother: namedRef(p.mother),
});

module.exports = { FILTER_RELATIONS, filterProjects, parseIdList, relationId, namedRef, forecastProjectOption };
