'use strict';

/**
 * The children that make a project a mother and add up into its totals: the
 * ones not in the trash (issues/135). A trashed project is left out of lists
 * and reports, but its mother still counted and summed it. `trashed` is null
 * on rows the ETL left without it, so "not trashed" is false or null.
 */
const NOT_TRASHED = { $or: [{ trashed: false }, { trashed: null }] };

const liveChildrenWhere = (motherId) => ({ mother: motherId, ...NOT_TRASHED });

module.exports = { NOT_TRASHED, liveChildrenWhere };
