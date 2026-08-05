'use strict';

/**
 * project CUSTOM routes (v5). Ported from v3 api/project/config/routes.json.
 * These are the 18 non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/projects automatically.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/basic',
      handler: 'project.findWithBasicInfo',
    },
    {
      method: 'GET',
      path: '/estimated-totals',
      handler: 'project.findEstimatedTotalsByDay',
    },
    {
      method: 'GET',
      path: '/verify-stored-totals',
      handler: 'project.verifyStoredTotals',
    },
    {
      method: 'GET',
      path: '/refresh-stored-totals',
      handler: 'project.refreshStoredTotals',
    },
    {
      method: 'GET',
      path: '/name',
      handler: 'project.findNames',
    },
    {
      method: 'GET',
      path: '/reset',
      handler: 'project.reset',
    },
    {
      method: 'GET',
      path: '/phases',
      handler: 'project.findWithPhases',
    },
    {
      method: 'GET',
      path: '/phases-both',
      handler: 'project.findWithPhasesBoth',
    },
    {
      method: 'GET',
      path: '/dedications',
      handler: 'project.findDedications',
    },
    {
      method: 'GET',
      path: '/real-dedications',
      handler: 'project.findRealDedications',
    },
    {
      method: 'GET',
      path: '/economic-detail',
      handler: 'project.findWithEconomicDetail',
    },
    {
      method: 'GET',
      path: '/update-phases',
      handler: 'project.updatePhases',
    },
    {
      method: 'GET',
      path: '/:id/children',
      handler: 'project.findChildren',
    },
    {
      method: 'GET',
      path: '/:id/phases',
      handler: 'project.findOneExtended',
    },
    {
      method: 'GET',
      path: '/:id/calculate',
      handler: 'project.calculateProject2',
    },
    {
      method: 'POST',
      path: '/create-phases',
      handler: 'project.createPhasesForAllProjects',
    },
    {
      method: 'PUT',
      path: '/:id/pay-expense/:expense',
      handler: 'project.payExpense',
    },
    {
      method: 'PUT',
      path: '/:id/pay-income/:income',
      handler: 'project.payIncome',
    },
  ],
};
