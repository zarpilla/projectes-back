'use strict';
/* global strapi */

/**
 * year lifecycles. A year's working hours price the jornadas that start in it
 * (issues/416): when they are created or changed, those jornadas are
 * re-priced, and with them their activities and planning lines. A jornada
 * saved before its year existed in «Anys» had the 1764 h fallback.
 */
const { rederiveYear } = require('../../../../services/dedication-cost');
const { pctChanged, remarkProjects } = require('../../../../services/deductible-vat-change');

const touchesHours = (event) => event.params && event.params.data && event.params.data.working_hours !== undefined;
const touchesVat = (event) => event.params && event.params.data && event.params.data.deductible_vat_pct !== undefined;

module.exports = {
  async afterCreate(event) {
    if (!event.result) return;
    await rederiveYear(event.result.year, event.result.working_hours);
    // the year's rows took Configuració's % until now (issues/440)
    if (touchesVat(event)) await remarkProjects(`year ${event.result.year} created`);
  },

  // the % before the change, to recompute the projects only when it changes (issues/440)
  async beforeUpdate(event) {
    if (!touchesVat(event)) return;
    const before = await strapi.db.query('api::year.year').findOne({ where: event.params.where, select: ['deductible_vat_pct'] });
    event.state = { ...(event.state || {}), deductibleVatPct: before ? before.deductible_vat_pct : null };
  },

  async afterUpdate(event) {
    if (!event.result) return;
    if (touchesHours(event)) await rederiveYear(event.result.year, event.result.working_hours);
    if (touchesVat(event) && event.state && pctChanged(event.state.deductibleVatPct, event.result.deductible_vat_pct)) {
      await remarkProjects(`«% IVA deduïble» of ${event.result.year}`);
    }
  },
};
