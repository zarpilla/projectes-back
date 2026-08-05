'use strict';

/**
 * project controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::project.project', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // TODO(P4): port project.findWithBasicInfo from v3 api/project/controllers/project.js
  async findWithBasicInfo(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findWithBasicInfo not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findEstimatedTotalsByDay from v3 api/project/controllers/project.js
  async findEstimatedTotalsByDay(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findEstimatedTotalsByDay not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.verifyStoredTotals from v3 api/project/controllers/project.js
  async verifyStoredTotals(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.verifyStoredTotals not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.refreshStoredTotals from v3 api/project/controllers/project.js
  async refreshStoredTotals(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.refreshStoredTotals not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findNames from v3 api/project/controllers/project.js
  async findNames(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findNames not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.reset from v3 api/project/controllers/project.js
  async reset(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.reset not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findWithPhases from v3 api/project/controllers/project.js
  async findWithPhases(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findWithPhases not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findWithPhasesBoth from v3 api/project/controllers/project.js
  async findWithPhasesBoth(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findWithPhasesBoth not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findDedications from v3 api/project/controllers/project.js
  async findDedications(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findDedications not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findRealDedications from v3 api/project/controllers/project.js
  async findRealDedications(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findRealDedications not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findWithEconomicDetail from v3 api/project/controllers/project.js
  async findWithEconomicDetail(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findWithEconomicDetail not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.updatePhases from v3 api/project/controllers/project.js
  async updatePhases(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.updatePhases not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findChildren from v3 api/project/controllers/project.js
  async findChildren(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findChildren not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.findOneExtended from v3 api/project/controllers/project.js
  async findOneExtended(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.findOneExtended not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.calculateProject2 from v3 api/project/controllers/project.js
  async calculateProject2(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.calculateProject2 not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.createPhasesForAllProjects from v3 api/project/controllers/project.js
  async createPhasesForAllProjects(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.createPhasesForAllProjects not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.payExpense from v3 api/project/controllers/project.js
  async payExpense(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.payExpense not yet ported (Phase 4)' };
  },
  // TODO(P4): port project.payIncome from v3 api/project/controllers/project.js
  async payIncome(ctx) {
    ctx.status = 501;
    ctx.body = { error: 'project.payIncome not yet ported (Phase 4)' };
  },
}));
