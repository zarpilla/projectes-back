'use strict';
/* global strapi */

/**
 * activity lifecycles (v5). Ported from v3 api/activity/models/activity.js.
 * Computes cost_by_hour from the covering daily-dedication; marks projects dirty.
 */
const { scheduleRefresh } = require('../../../project/services/totalsRefreshScheduler');

module.exports = {
  async beforeCreate(event) {
    await calculatePrice(0, event.data);
  },
  async afterCreate(event) {
    const result = event.result;
    if (result && result.project) {
      scheduleRefresh(result.project.id || result.project);
    }
  },
  async beforeUpdate(event) {
    await calculatePrice(event.params.where.id, event.data);
  },
  async afterUpdate(event) {
    const result = event.result;
    const data = event.params.data;
    if (result && result.project) {
      scheduleRefresh(result.project.id || result.project);
    }
    // Refresh the previous project too if the activity was reassigned.
    if (
      data &&
      data.project &&
      result &&
      (!result.project || (result.project.id || result.project) !== (data.project.id || data.project))
    ) {
      scheduleRefresh(data.project.id || data.project);
    }
  },
  async beforeDelete(event) {
    const activity = await strapi.db.query('api::activity.activity').findOne({ where: event.params.where });
    if (activity && activity.project) {
      scheduleRefresh(activity.project.id || activity.project);
    }
  },
};

async function calculatePrice(id, data) {
  if (data && !data.cost_by_hour && data.users_permissions_user) {
    const dedications = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findMany({ where: { users_permissions_user: data.users_permissions_user } });
    if (dedications.length) {
      const dedication = dedications.find((d) => d.from <= data.date && d.to >= data.date);
      if (dedication) {
        data.cost_by_hour = dedication.costByHour || 0;
      }
    }
  }
}
