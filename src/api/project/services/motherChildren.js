'use strict';
/* global strapi */

/**
 * The children that make a project a mother and add up into its totals: the
 * ones not in the trash (issues/135). A trashed project is left out of lists
 * and reports, but its mother still counted and summed it. `trashed` is null
 * on rows the ETL left without it, so "not trashed" is false or null.
 */
const NOT_TRASHED = { $or: [{ trashed: false }, { trashed: null }] };

const liveChildrenWhere = (motherId) => ({ mother: motherId, ...NOT_TRASHED });

const SUMMED_TOTALS = [
  'total_original_incomes',
  'total_original_expenses',
  'total_original_hours',
  'total_original_hours_price',
  'total_original_expenses_vat',
  'original_incomes_expenses',
  'total_estimated_incomes',
  'total_estimated_expenses',
  'total_estimated_hours',
  'total_estimated_hours_price',
  'total_estimated_expenses_vat',
  'estimated_incomes_expenses',
  'total_real_incomes',
  'total_real_expenses',
  'total_real_hours',
  'total_real_hours_price',
  'total_real_expenses_vat',
  'total_real_incomes_expenses',
];

/**
 * A mother's figures are its children's, added up: what it has on itself
 * (legacy hours and costs from before it had children) doesn't count
 * (issues/172). The one definition behind the list, Projectes mare and the form.
 */
const addChildrenTotals = (mother, children) => {
  if (!children || children.length === 0) return mother;
  for (const f of [...SUMMED_TOTALS, 'total_incomes', 'total_expenses', 'incomes_expenses']) mother[f] = 0;
  for (const child of children) {
    for (const f of SUMMED_TOTALS) mother[f] += parseFloat(child[f] || 0);
    // Backwards-compat fields fall back to the estimated dimension.
    mother.total_incomes += parseFloat(child.total_incomes || child.total_estimated_incomes || 0);
    mother.total_expenses += parseFloat(child.total_expenses || child.total_estimated_expenses || 0);
    mother.incomes_expenses += parseFloat(child.incomes_expenses || child.estimated_incomes_expenses || 0);
  }
  return mother;
};

/** addChildrenTotals on every mother of a list, with one query for all their children. */
const addChildrenTotalsToList = async (projects) => {
  const mothers = projects.filter((p) => p && p.is_mother);
  if (mothers.length === 0) return projects;
  const children = await strapi.db.query('api::project.project').findMany({
    where: { mother: { id: { $in: mothers.map((m) => m.id) } }, ...NOT_TRASHED },
    populate: { mother: { select: ['id'] } },
  });
  for (const mother of mothers) {
    addChildrenTotals(mother, children.filter((c) => c.mother && c.mother.id === mother.id));
  }
  return projects;
};

module.exports = { NOT_TRASHED, liveChildrenWhere, addChildrenTotals, addChildrenTotalsToList };
