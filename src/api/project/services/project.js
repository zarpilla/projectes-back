'use strict';
/* global strapi */

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/services.html#core-services)
 * to customize this service
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
