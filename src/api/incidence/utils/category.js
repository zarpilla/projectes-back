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

module.exports = { DEFAULT_CATEGORIES, categoryIdOf, categoryRefusal, seedIncidenceCategories };
