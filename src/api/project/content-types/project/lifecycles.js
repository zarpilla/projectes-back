'use strict';
/* global strapi */

/**
 * project lifecycles (v5). Ported from v3 api/project/models/project.js.
 *
 * - beforeCreate: extracts nested phases (the ORM can't handle deep nested
 *   creates) and stashes them on event.state (v5's cross-hook carrier) for
 *   afterCreate to materialize via the project service.
 * - beforeUpdate: recomputes ALL financial totals from the fully-populated
 *   project (the financial engine's calculateProject) and merges them into the
 *   update. The phase materialization it used to do moved to the controller's
 *   update override: v5 validates the input body before the service runs, so the
 *   v3 control fields it keys off (`_project_phases_updated`, …) have to be
 *   consumed while the request is still in the controller.
 * - afterCreate/afterUpdate/afterDelete: maintain the is_mother flag on mother
 *   projects (direct db.query updates — the v3 `_internal` flag bypass).
 * - afterFind/afterFindOne (mother aggregation) moved to the project controller's
 *   find/findOne overrides (v5 removed those hooks).
 */
const { PROJECT_GRAPH_FOR_TOTALS_POPULATE } = require('../../services/projectFinancials');
const { resolveComponentRefs } = require('../../../../services/component-refs');

module.exports = {
  async beforeCreate(event) {
    const data = event.params.data;

    // Extract phases before the ORM sees them (deep nested creates unsupported).
    if (data.project_original_phases && data.project_original_phases.length > 0) {
      event.state.originalPhases = data.project_original_phases;
      delete data.project_original_phases;
      delete data.project_original_phases_info;
    }
    if (data.project_phases && data.project_phases.length > 0) {
      event.state.executionPhases = data.project_phases;
      delete data.project_phases;
      delete data.project_phases_info;
    }
  },

  async afterCreate(event) {
    const result = event.result;
    const state = event.state || {};

    // Materialize phases extracted in beforeCreate.
    if (state.originalPhases && state.originalPhases.length > 0) {
      for (const phase of state.originalPhases) {
        await strapi
          .controller('api::project.project')
          .createPhaseWithNested(result.id, 'project-original-phases', phase);
      }
    }
    if (state.executionPhases && state.executionPhases.length > 0) {
      for (const phase of state.executionPhases) {
        await strapi
          .controller('api::project.project')
          .createPhaseWithNested(result.id, 'project-phases', phase);
      }
    }

    // If the new project has a mother, flag the mother.
    if (result.mother) {
      const motherId = relationId(result.mother);
      await updateIsMother(motherId);
    }
  },

  async beforeUpdate(event) {
    const data = event.params.data;
    const id = event.params.where.id || event.params.where.documentId;

    // Store the old mother when the mother field changes.
    if (data.mother !== undefined) {
      const current = await strapi.db
        .query('api::project.project')
        .findOne({ where: { id }, populate: { mother: true } });
      event.state.oldMotherId = relationId(current?.mother);
    }

    // Recompute financials from the FULL project (data only carries changed fields).
    const fullProject = await strapi.db
      .query('api::project.project')
      .findOne({ where: { id }, populate: PROJECT_GRAPH_FOR_TOTALS_POPULATE });

    // Merge updated scalar fields; never overwrite relations with stale frontend data.
    const {
      project_phases,
      project_original_phases,
      activities,
      project_phases_info,
      project_original_phases_info,
      _project_phases_updated,
      _project_original_phases_updated,
      ...dataToMerge
    } = data;
    // Components (periodification, grantable_*) arrive here as bare
    // `{ id, __pivot }` references: merged as-is they replaced the loaded rows
    // and the financials read `pp.year` off a reference — a 500 on every save
    // with a periodification. Merge their stored values instead.
    await resolveComponentRefs('api::project.project', dataToMerge);
    Object.assign(fullProject, dataToMerge);

    const calculatedData = await strapi.controller('api::project.project').calculateProject(fullProject, id);
    Object.assign(data, calculatedData);
    // calculatedData IS the loaded project, so the assign above also copied the
    // graph it was loaded with — every activity and phase, fully populated — into
    // the update. The db layer then "set" those relations again: a deep-equal
    // de-duplication over thousands of activity rows (7s of CPU on a project
    // with 4,400 activities) followed by a rewrite of all their link rows. They
    // are only inputs of the calculation and never change here (issues/016).
    for (const relation of Object.keys(PROJECT_GRAPH_FOR_TOTALS_POPULATE)) {
      delete data[relation];
    }
  },

  async afterUpdate(event) {
    // Maintain is_mother on the old/new mother when the mother field changed.
    const state = event.state || {};
    if (state.oldMotherId !== undefined) {
      const data = event.params.data || {};
      const oldMotherId = state.oldMotherId;
      const newMotherId = relationId(data.mother);
      if (oldMotherId !== newMotherId) {
        if (oldMotherId) await updateIsMother(oldMotherId);
        if (newMotherId) await updateIsMother(newMotherId);
      }
    }
  },

  async afterDelete(event) {
    const result = event.result;
    if (result.mother) {
      const motherId = relationId(result.mother);
      await updateIsMother(motherId);
    }
  },
};

// Numeric id out of a to-one relation value. By the time db lifecycles run, the
// document service has rewritten the input into `{ set: [{ id }] }` (or
// connect/disconnect), so `data.mother` is rarely a bare id or `{ id }`.
function relationId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return Number(value) || null;
  if (Array.isArray(value)) return relationId(value[0]);
  if (typeof value === 'object') {
    if (value.id !== undefined) return relationId(value.id);
    if (value.set !== undefined) return relationId(value.set);
    if (value.connect !== undefined) return relationId(value.connect);
    if (value.disconnect !== undefined) return null;
  }
  return null;
}

// Set is_mother from the live child count (direct db update: lifecycle bypass).
async function updateIsMother(motherId) {
  const count = await strapi.db.query('api::project.project').count({ where: { mother: motherId } });
  await strapi.db
    .query('api::project.project')
    .update({ where: { id: motherId }, data: { is_mother: count > 0 } });
}
