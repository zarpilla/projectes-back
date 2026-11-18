'use strict';
/* global strapi */

/**
 * The cause of an incidence (issues/431): the Diligència groups and reports
 * its incidences by a category picked from «Categories d'incidència» (Taules
 * auxiliars, edited by admins). A new incidence must have one as soon as the
 * entity has categories; an entity without any (no logistics) goes on as
 * before. The incidences the server opens itself (a late order, issues/363)
 * are not refused.
 */
const CATEGORY = 'api::incidence-category.incidence-category';
const INCIDENCE = 'api::incidence.incidence';

// The category of the incidences the server opens for a late order (issues/363):
// found by its system_key, so admins can rename it (Diligència, 2026-11-18).
const LATE_ORDER_KEY = 'late_order';
const LATE_ORDER_NAME = 'Comanda registrada fora de temps';

// The Diligència's list (ticket 431), loaded once on the entities with orders.
const DEFAULT_CATEGORIES = [
  'Causa major repartiment Logística (Accidents, Manifestació, Avaries, Climatologia…)',
  'Paquet perdut',
  "Retard en l'entrega",
  "S'ha malmès el contingut del paquet",
  'Condicions del paquet incorrectes (Pes, malmès, sense tapar, etc…)',
  'Informació detalls comanda incorrecta (Número de caixes, pes, refrigerat…)',
  'Informació punt entrega incorrecta (Horari, Adreça, detalls repartidores…)',
  'No dipositat al magatzem / finca',
  'Falta albarà',
  'Comanda no informada',
  LATE_ORDER_NAME,
  'Altres causes',
];

const MISSING = "Tria la categoria de la incidència.";
const UNKNOWN = "La categoria de la incidència no existeix.";

/** The category id an incidence carries: `3`, `"3"` or `{ id: 3 }`; null when none. */
function categoryIdOf(value) {
  const id = value && typeof value === 'object' ? value.id : value;
  if (id === null || id === undefined || id === '') return null;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Why the incidences an order save creates can't be saved, or null. Only the
 * new ones (no id): the existing ones keep whatever they have.
 */
async function categoryRefusal(incidences) {
  const created = (incidences || []).filter((i) => i && typeof i === 'object' && !i.id);
  const changed = (incidences || []).filter((i) => i && typeof i === 'object' && i.id && 'category' in i);
  if (!created.length && !changed.length) return null;
  const categories = await strapi.db.query(CATEGORY).findMany({ select: ['id'] });
  if (!categories.length) return null;
  const known = new Set(categories.map((c) => c.id));
  for (const incidence of created) {
    const id = categoryIdOf(incidence.category);
    if (id === null) return MISSING;
    if (!known.has(id)) return UNKNOWN;
  }
  for (const incidence of changed) {
    const id = categoryIdOf(incidence.category);
    if (id !== null && !known.has(id)) return UNKNOWN;
  }
  return null;
}

/**
 * Startup script: the Diligència's categories on an entity that has orders and
 * no category yet. The others get none, so nothing is required of them.
 */
async function seedIncidenceCategories() {
  const existing = await strapi.db.query(CATEGORY).count();
  if (existing > 0) return;
  const orders = await strapi.db.query('api::order.order').count();
  if (!orders) return;
  for (const [index, name] of DEFAULT_CATEGORIES.entries()) {
    await strapi.db.query(CATEGORY).create({ data: { name, order: index + 1 } });
  }
  strapi.log.info(`[incidence categories] ${DEFAULT_CATEGORIES.length} categories created`);
}

/**
 * The id of the late-order category, or null on an entity without categories
 * (it doesn't use them: nothing to add). Created when missing (deleted by an
 * admin, or the entity got its categories by hand); one with its name already
 * there takes the key.
 */
async function lateOrderCategoryId() {
  const query = strapi.db.query(CATEGORY);
  const categories = await query.findMany({ select: ['id', 'name', 'order', 'system_key'] });
  if (!categories.length) return null;
  const keyed = categories.find((c) => c.system_key === LATE_ORDER_KEY);
  if (keyed) return keyed.id;
  const named = categories.find((c) => String(c.name || '').trim().toLowerCase() === LATE_ORDER_NAME.toLowerCase());
  if (named) {
    await query.update({ where: { id: named.id }, data: { system_key: LATE_ORDER_KEY } });
    return named.id;
  }
  const order = Math.max(0, ...categories.map((c) => Number(c.order) || 0)) + 1;
  const created = await query.create({ data: { name: LATE_ORDER_NAME, order, system_key: LATE_ORDER_KEY } });
  strapi.log.info(`[incidence categories] «${LATE_ORDER_NAME}» created`);
  return created.id;
}

// the texts openLateIncidence writes (late-incidence.js)
const LATE_TEXT = /^(Comanda fora de temps:|Recollida informada tard:)/;

/**
 * Startup script: the late-order category, and the late incidences opened
 * before it without a category go into it (no mails).
 */
async function categorizeLateIncidences() {
  const categoryId = await lateOrderCategoryId();
  if (!categoryId) return;
  const incidences = await strapi.db.query(INCIDENCE).findMany({
    select: ['id', 'description'],
    populate: { category: { select: ['id'] } },
  });
  const late = incidences.filter((i) => !i.category && LATE_TEXT.test(String(i.description || '')));
  // straight into the link table: an update through the query engine runs the
  // incidence lifecycles, which mail the office and the member every time
  if (late.length) {
    await strapi.db
      .connection('incidences_category_lnk')
      .insert(late.map((i) => ({ incidence_id: i.id, incidence_category_id: categoryId })));
  }
  strapi.log.info(`[incidence categories] ${late.length} late incidences into «${LATE_ORDER_NAME}»`);
}

module.exports = {
  DEFAULT_CATEGORIES,
  LATE_ORDER_KEY,
  LATE_ORDER_NAME,
  categoryIdOf,
  categoryRefusal,
  seedIncidenceCategories,
  lateOrderCategoryId,
  categorizeLateIncidences,
};
