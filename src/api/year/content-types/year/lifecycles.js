'use strict';

/**
 * year lifecycles. A year's working hours price the jornadas that start in it
 * (issues/416): when they are created or changed, those jornadas are
 * re-priced, and with them their activities and planning lines. A jornada
 * saved before its year existed in «Anys» had the 1764 h fallback.
 */
const { rederiveYear } = require('../../../../services/dedication-cost');

const touchesHours = (event) => event.params && event.params.data && event.params.data.working_hours !== undefined;

module.exports = {
  async afterCreate(event) {
    if (!event.result) return;
    await rederiveYear(event.result.year, event.result.working_hours);
  },

  async afterUpdate(event) {
    if (!event.result || !touchesHours(event)) return;
    await rederiveYear(event.result.year, event.result.working_hours);
  },
};
