'use strict';

/**
 * project CUSTOM routes (v5). Ported from v3 api/project/config/routes.json.
 * These are the 18 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 mounts custom routes at /api + the path exactly as written — it does NOT
 * namespace them by content type, so each path keeps its v3 plural prefix.
 * The `01-` filename prefix matters: route files load in alphabetical order and
 * the core router's `/<plural>/:id` would otherwise shadow static paths like
 * `/<plural>/basic`.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/projects/basic',
      handler: 'project.findWithBasicInfo',
    },
    {
      method: 'GET',
      path: '/projects/estimated-totals',
      handler: 'project.findEstimatedTotalsByDay',
    },
    {
      method: 'GET',
      path: '/projects/verify-stored-totals',
      handler: 'project.verifyStoredTotals',
    },
    {
      method: 'GET',
      path: '/projects/refresh-stored-totals',
      handler: 'project.refreshStoredTotals',
    },
    {
      method: 'GET',
      path: '/projects/name',
      handler: 'project.findNames',
    },
    {
      method: 'GET',
      path: '/projects/reset',
      handler: 'project.reset',
    },
    {
      method: 'GET',
      path: '/projects/phases',
      handler: 'project.findWithPhases',
    },
    {
      method: 'GET',
      path: '/projects/phases-both',
      handler: 'project.findWithPhasesBoth',
    },
    {
      method: 'GET',
      path: '/projects/dedications',
      handler: 'project.findDedications',
    },
    {
      method: 'GET',
      path: '/projects/real-dedications',
      handler: 'project.findRealDedications',
    },
    {
      method: 'GET',
      path: '/projects/economic-detail',
      handler: 'project.findWithEconomicDetail',
    },
    {
      method: 'GET',
      path: '/projects/update-phases',
      handler: 'project.updatePhases',
    },
    {
      method: 'GET',
      path: '/projects/:id/children',
      handler: 'project.findChildren',
    },
    {
      method: 'GET',
      path: '/projects/:id/phases',
      handler: 'project.findOneExtended',
    },
    {
      method: 'GET',
      path: '/projects/:id/calculate',
      handler: 'project.calculateProject2',
    },
    {
      method: 'POST',
      path: '/projects/create-phases',
      handler: 'project.createPhasesForAllProjects',
    },
    {
      method: 'PUT',
      path: '/projects/:id/pay-expense/:expense',
      handler: 'project.payExpense',
    },
    {
      method: 'PUT',
      path: '/projects/:id/pay-income/:income',
      handler: 'project.payIncome',
    },
  ],
};
