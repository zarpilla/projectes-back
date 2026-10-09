'use strict';
/* global strapi */

/**
 * activity lifecycles (v5). Ported from v3 api/activity/models/activity.js.
 * Computes cost_by_hour from the covering daily-dedication; marks projects dirty.
 */
const { scheduleRefresh } = require('../../../project/services/totalsRefreshScheduler');
const { relationId } = require('../../../../services/relation-input');

module.exports = {
  async beforeCreate(event) {
    await calculatePrice(0, event.params.data);
  },
  async afterCreate(event) {
    // A v5 db lifecycle result carries no relations: read the project back
    // (issues/012 — the project was never marked and its real hours went stale).
    const result = event.result;
    if (result && result.id) {
      scheduleRefresh(await activityProjectId(result.id));
    }
  },
  async beforeUpdate(event) {
    await calculatePrice(event.params.where.id, event.params.data);
    // Remember the project before the write, to refresh it too if the
    // activity moves to another one.
    event.state = event.state || {};
    event.state.previousProjectId = await activityProjectId(event.params.where.id);
  },
  async afterUpdate(event) {
    const result = event.result;
    const projectId = result && result.id ? await activityProjectId(result.id) : undefined;
    if (projectId) scheduleRefresh(projectId);
    const previousProjectId = event.state && event.state.previousProjectId;
    if (previousProjectId && previousProjectId !== projectId) {
      scheduleRefresh(previousProjectId);
    }
  },
  async beforeDelete(event) {
    const where = event.params.where;
    if (where && where.id) {
      scheduleRefresh(await activityProjectId(where.id));
    }
  },
};

async function activityProjectId(id) {
  if (!id) return undefined;
  const activity = await strapi.db
    .query('api::activity.activity')
    .findOne({ where: { id }, select: ['id'], populate: { project: { select: ['id'] } } });
  return activity && activity.project ? activity.project.id : undefined;
}

async function calculatePrice(id, data) {
  if (data && !data.cost_by_hour && data.users_permissions_user) {
    const dedications = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findMany({ where: { users_permissions_user: relationId(data.users_permissions_user) } });
    if (dedications.length) {
      const dedication = dedications.find((d) => d.from <= data.date && d.to >= data.date);
      if (dedication) {
        data.cost_by_hour = dedication.costByHour || 0;
      }
    }
  }
}
