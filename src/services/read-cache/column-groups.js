'use strict';

/**
 * Column groups of the read cache (issues/328, see change-tracker.js).
 *
 * `projects#totals`: the stored totals and the `dirty` flag. Every hours entry
 * and every budget line change marks its project dirty, and the totals cron
 * writes the totals two minutes later; as plain `projects` writes they dropped
 * every cached result that read a project (the Tresoreria forecast many times
 * an hour on a busy tenant). Results that hold these columns still depend on
 * them; only a caller whose data holds none says so with `ignoreGroups`.
 */

const { STORED_TOTAL_FIELDS } = require('../../api/project/services/projectFinancials');

const PROJECT_TOTALS = 'projects#totals';

// also total_expenses_hours: the legacy mirror written with the totals
const PROJECT_TOTALS_COLUMNS = [...STORED_TOTAL_FIELDS, 'total_expenses_hours', 'dirty'];

const COLUMN_GROUPS = { projects: { totals: PROJECT_TOTALS_COLUMNS } };

module.exports = { COLUMN_GROUPS, PROJECT_TOTALS, PROJECT_TOTALS_COLUMNS };
