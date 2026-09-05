'use strict';
/* global strapi */

/**
 * In-process cache of daily dedications and festives, shared by the project
 * financials engine. Consumers mark it dirty from the daily-dedication and
 * festive lifecycles when the underlying rows change.
 *
 * (Split from services/project.js, which must be a createCoreService — a
 * plain-object export there left the core CRUD service methods unregistered
 * and made GET /api/projects 500 with "find is not a function".)
 */

const stateInternal = {
  dailyDedicationsDirty: true,
  dailyDedications: [],
  festivesDirty: true,
  festives: [],
};

module.exports = {
  setDailyDedicationsDirty: (val) => {
    stateInternal.dailyDedicationsDirty = val;
  },
  setFestivesDirty: (val) => {
    stateInternal.festivesDirty = val;
  },
  getDailyDedicationsDirty: () => {
    return stateInternal.dailyDedicationsDirty;
  },
  getFestivesDirty: () => {
    return stateInternal.festivesDirty;
  },
  getDailyDedications: async () => {
    if (!stateInternal.dailyDedicationsDirty) {
      return stateInternal.dailyDedications;
    }
    const dailyDedications = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findMany();
    stateInternal.dailyDedications = dailyDedications;
    stateInternal.dailyDedicationsDirty = false;

    return dailyDedications;
  },
  getFestives: async () => {
    if (!stateInternal.festivesDirty) {
      return stateInternal.festives;
    }
    const festives = await strapi.db.query('api::festive.festive').findMany();
    stateInternal.festives = festives;
    stateInternal.festivesDirty = false;
    return festives;
  },
};
