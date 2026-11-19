'use strict';
/* global strapi */

/**
 * issues/440: the stored project totals (project_totals, issues/328) hold the
 * non-deductible VAT («prorrata») of each year's «% IVA deduïble». Changing a
 * year's % (Taules auxiliars › Anys) or Configuració's (used by the years
 * without one) left them as they were: the projects kept showing the old
 * prorrata until something else touched them. Now such a change marks every
 * project dirty and the totals cron recomputes them within minutes.
 *
 * Only an actual change counts: Configuració is saved whole every time.
 */
const { markAllDirty } = require('../api/project/services/project-totals');

const pctOf = (value) => (value === null || value === undefined || value === '' ? null : Number(value));

const pctChanged = (before, after) => pctOf(before) !== pctOf(after);

async function remarkProjects(reason) {
  const count = await markAllDirty();
  strapi.log.info(`[deductible-vat] ${reason}: ${count} projects marked dirty to recompute their prorrata`);
  return count;
}

// the % an update of `me` sets, or undefined when it doesn't touch it
const newMePct = (data) =>
  data && data.options && typeof data.options === 'object' && 'deductible_vat_pct' in data.options
    ? data.options.deductible_vat_pct
    : undefined;

async function currentMePct() {
  const me = await strapi.db.query('api::me.me').findOne({ populate: ['options'] });
  return me && me.options ? me.options.deductible_vat_pct : null;
}

/**
 * Document-service middleware (src/index.js): Configuració saved with another
 * «% IVA deduïble» recomputes the projects. Compared before and after the
 * save: the `me` lifecycles only see the options component as a reference
 * ({ id, __pivot }), never its % (found 2026-11-19, issues/436), so the
 * recompute never ran from Configuració.
 */
async function remarkOnMePctChange(context, next) {
  const { uid, action, params } = context;
  if (uid !== 'api::me.me' || action !== 'update' || newMePct(params && params.data) === undefined) return next();
  const before = await currentMePct();
  const result = await next();
  const after = await currentMePct();
  if (pctChanged(before, after)) await remarkProjects('«% IVA deduïble» of Configuració');
  return result;
}

module.exports = { pctChanged, remarkProjects, newMePct, currentMePct, remarkOnMePctChange };
