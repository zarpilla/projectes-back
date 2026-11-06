'use strict';
/* global strapi */

/**
 * «Esborrar projecte» sends the project to the trash, and a trashed project is
 * left out of the lists and of the reports by project (Ingressos/Despeses,
 * Preu hora, Dedicació, the forecasts). A project that already has documents
 * or logged hours can't go there (2026-11-06): its invoices and expenses still
 * count in Tresoreria and IVA, its hours in each person's views, so the
 * reports by project would stop adding up with them. And a numbered project
 * gives its number back to the series when trashed: a code already printed on
 * an invoice would be taken again. Such a project is closed with its state.
 */

// what keeps a project out of the trash, in the order the message names it
const BLOCKERS = [
  { uid: 'api::emitted-invoice.emitted-invoice', many: true, one: 'factura emesa', other: 'factures emeses' },
  { uid: 'api::received-invoice.received-invoice', many: true, one: 'factura rebuda', other: 'factures rebudes' },
  { uid: 'api::received-expense.received-expense', many: true, one: 'despesa', other: 'despeses' },
  { uid: 'api::received-income.received-income', many: true, one: 'ingrés', other: 'ingressos' },
  { uid: 'api::emitted-grant.emitted-grant', one: 'subvenció emesa', other: 'subvencions emeses' },
  { uid: 'api::received-grant.received-grant', one: 'subvenció rebuda', other: 'subvencions rebudes' },
  { uid: 'api::quote.quote', one: 'pressupost', other: 'pressupostos' },
  { uid: 'api::diet.diet', one: 'dieta', other: 'dietes' },
  { uid: 'api::treasury.treasury', one: 'moviment de tresoreria', other: 'moviments de tresoreria' },
  { uid: 'api::activity.activity', one: "registre d'hores", other: "registres d'hores" },
];

const blockerWhere = (blocker, id) =>
  blocker.many
    ? { $or: [{ project: { id } }, { projects: { id } }] }
    : { project: { id } };

/** What the project has that keeps it out of the trash: [{ label, count }]. */
async function trashBlockers(projectId) {
  const counts = await Promise.all(
    BLOCKERS.map((b) => strapi.db.query(b.uid).count({ where: blockerWhere(b, projectId) })),
  );
  return BLOCKERS.map((b, i) => ({ blocker: b, count: Number(counts[i]) || 0 }))
    .filter(({ count }) => count > 0)
    .map(({ blocker, count }) => ({ count, label: `${count} ${count === 1 ? blocker.one : blocker.other}` }));
}

const joinLabels = (labels) =>
  labels.length > 1 ? `${labels.slice(0, -1).join(', ')} i ${labels[labels.length - 1]}` : labels[0];

/**
 * The message refusing to trash project `id` (numeric id or documentId), or
 * null when it can go to the trash.
 */
async function trashError(id) {
  const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
  const project = await strapi.db.query('api::project.project').findOne({ where, select: ['id', 'trashed'] });
  if (!project || project.trashed === true) return null;
  const blockers = await trashBlockers(project.id);
  if (!blockers.length) return null;
  return (
    `No es pot esborrar el projecte: té ${joinLabels(blockers.map((b) => b.label))}. ` +
    "Si ja no hi treballeu, tanca'l canviant-ne l'estat."
  );
}

module.exports = { BLOCKERS, trashBlockers, trashError };
