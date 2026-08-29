'use strict';
/* global strapi */

/**
 * project lifecycles (v5). Ported from v3 api/project/models/project.js.
 *
 * - beforeCreate: extracts nested phases (the ORM can't handle deep nested
 *   creates) and stashes them on event.state (v5's cross-hook carrier) for
 *   afterCreate to materialize via the project service.
 * - beforeUpdate: materializes phase updates (updatePhases), then recomputes ALL
 *   financial totals from the fully-populated project (the financial engine's
 *   calculateProject) and merges them into the update.
 * - afterCreate/afterUpdate/afterDelete: maintain the is_mother flag on mother
 *   projects (direct db.query updates — the v3 `_internal` flag bypass).
 * - afterFind/afterFindOne (mother aggregation) moved to the project controller's
 *   find/findOne overrides (v5 removed those hooks).
 */
const { PROJECT_GRAPH_FOR_TOTALS_POPULATE } = require('../../services/projectFinancials');

module.exports = {
  async beforeCreate(event) {
    const data = event.data;

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
      const motherId = result.mother.id || result.mother;
      await updateIsMother(motherId);
    }
  },

  async beforeUpdate(event) {
    const data = event.data;
    const id = event.params.where.id || event.params.where.documentId;

    // Store the old mother when the mother field changes.
    if (data.mother !== undefined) {
      const current = await strapi.db
        .query('api::project.project')
        .findOne({ where: { id }, populate: { mother: true } });
      event.state.oldMotherId = current?.mother?.id || current?.mother || null;
    }

    if (
      data.project_original_phases &&
      data.project_original_phases_info &&
      data._project_original_phases_updated
    ) {
      await strapi
        .controller('api::project.project')
        .updatePhases(
          id,
          'project-original-phases',
          data.project_original_phases,
          data.project_original_phases_info.deletedPhases || [],
          data.project_original_phases_info.deletedIncomes || [],
          data.project_original_phases_info.deletedExpenses || [],
          data.project_original_phases_info.deletedHours || [],
        );
    }

    if (data.project_phases && data.project_phases_info && data._project_phases_updated) {
      await strapi
        .controller('api::project.project')
        .updatePhases(
          id,
          'project-phases',
          data.project_phases,
          data.project_phases_info.deletedPhases || [],
          data.project_phases_info.deletedIncomes || [],
          data.project_phases_info.deletedExpenses || [],
          data.project_phases_info.deletedHours || [],
        );
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
    Object.assign(fullProject, dataToMerge);

    const calculatedData = await strapi.controller('api::project.project').calculateProject(fullProject, id);
    Object.assign(data, calculatedData);
  },

  async afterUpdate(event) {
    // Maintain is_mother on the old/new mother when the mother field changed.
    const state = event.state || {};
    if (state.oldMotherId !== undefined) {
      const data = event.params.data || {};
      const oldMotherId = state.oldMotherId;
      const newMotherId = data.mother?.id || data.mother || null;
      if (oldMotherId !== newMotherId) {
        if (oldMotherId) await updateIsMother(oldMotherId);
        if (newMotherId) await updateIsMother(newMotherId);
      }
    }
  },

  async afterDelete(event) {
    const result = event.result;
    if (result.mother) {
      const motherId = result.mother.id || result.mother;
      await updateIsMother(motherId);
    }
  },
};

// Set is_mother from the live child count (direct db update: lifecycle bypass).
async function updateIsMother(motherId) {
  const count = await strapi.db.query('api::project.project').count({ where: { mother: motherId } });
  await strapi.db
    .query('api::project.project')
    .update({ where: { id: motherId }, data: { is_mother: count > 0 } });
}
