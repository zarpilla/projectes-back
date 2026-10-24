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
 * - afterFindMany/afterFindOne: the stored totals and `dirty` live in
 *   `project_totals` (issues/328); every project read gets them back here, so
 *   the API answers as when they were columns of `projects`. beforeUpdate keeps
 *   the totals it computes out of the `projects` update and afterUpdate writes
 *   them there; afterCreate marks a new project dirty.
 */
const { PROJECT_GRAPH_FOR_TOTALS_POPULATE } = require('../../services/projectFinancials');
const { resolveComponentRefs } = require('../../../../services/component-refs');
const { liveChildrenWhere } = require('../../services/motherChildren');
const projectTotals = require('../../services/project-totals');

module.exports = {
  async afterFindMany(event) {
    if (Array.isArray(event.result) && projectTotals.wantsTotals(event.params)) {
      await projectTotals.attachTotals(event.result);
    }
  },

  async afterFindOne(event) {
    if (event.result && projectTotals.wantsTotals(event.params)) {
      await projectTotals.attachTotals(event.result);
    }
  },

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

    // its totals are computed by the cron (they were never computed on create)
    await projectTotals.markDirty(result.id);

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

    // Store the old mother when the mother field changes, or the mother whose
    // live children change when the project goes in or out of the trash (issues/135).
    if (data.mother !== undefined || data.trashed !== undefined) {
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
    // The references themselves stay in the update: the db layer links the
    // components through their `__pivot` (field + component_type).
    const componentFields = Object.entries(strapi.contentType('api::project.project').attributes)
      .filter(([, attribute]) => attribute.type === 'component')
      .map(([field]) => field);
    const componentRefs = Object.fromEntries(
      componentFields.filter((field) => field in data).map((field) => [field, data[field]]),
    );
    await resolveComponentRefs('api::project.project', dataToMerge);
    Object.assign(fullProject, dataToMerge);

    const calculatedData = await strapi.controller('api::project.project').calculateProject(fullProject, id);
    Object.assign(data, calculatedData);
    // the totals go to project_totals (afterUpdate), never to `projects`; `dirty`
    // stays as stored (issues/328)
    event.state.totals = {};
    for (const column of projectTotals.COLUMNS) {
      if (column !== 'dirty' && data[column] !== undefined) event.state.totals[column] = data[column];
      delete data[column];
    }
    // The assign above also put the resolved rows back in place of the
    // references: linked without a `__pivot`, every save added an untyped copy
    // of each periodification / grant row, and the API returned each one once
    // more per save (issues/232).
    for (const field of componentFields) {
      if (field in componentRefs) data[field] = componentRefs[field];
      else delete data[field];
    }
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
    const state = event.state || {};
    if (state.totals && event.result && event.result.id) {
      await projectTotals.writeTotals(event.result.id, state.totals);
    }

    // Maintain is_mother on the old/new mother when the mother field changed,
    // or on the mother when the project went in or out of the trash.
    if (state.oldMotherId !== undefined) {
      const data = event.params.data || {};
      const oldMotherId = state.oldMotherId;
      const newMotherId = relationId(data.mother);
      if (data.mother === undefined) {
        // only the trash state changed: the same mother
        if (oldMotherId) await updateIsMother(oldMotherId);
      } else if (oldMotherId !== newMotherId) {
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

// Set is_mother from the live child count, trashed children left out (direct
// db update: lifecycle bypass).
async function updateIsMother(motherId) {
  const count = await strapi.db.query('api::project.project').count({ where: liveChildrenWhere(motherId) });
  await strapi.db
    .query('api::project.project')
    .update({ where: { id: motherId }, data: { is_mother: count > 0 } });
}
