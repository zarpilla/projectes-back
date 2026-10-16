'use strict';
/* global strapi */

/**
 * The «Imports diferents» warning of the project lines (issues/094).
 *
 * A document (emitted or received invoice, income, expense) can be split over
 * several project lines, in one or more projects. Each of those lines stores
 * `warning`: true when the lines linked to the document don't add up to its
 * base. The document form computes it when the document is saved, but editing
 * the lines in the project left it stale. refreshLineWarnings recomputes it
 * from all the execution lines of the given documents; the project update
 * calls it for the documents its lines pointed to before and after the save.
 *
 * Only `warning` changes, with updateMany: it joins the project update's
 * transaction, and the line lifecycles have no *UpdateMany hooks, so the
 * totals queue isn't triggered for a field no total depends on.
 */

const LINKS = [
  { line: 'api::phase-income.phase-income', field: 'invoice', doc: 'api::emitted-invoice.emitted-invoice' },
  { line: 'api::phase-income.phase-income', field: 'income', doc: 'api::received-income.received-income' },
  { line: 'api::phase-expense.phase-expense', field: 'invoice', doc: 'api::received-invoice.received-invoice' },
  { line: 'api::phase-expense.phase-expense', field: 'expense', doc: 'api::received-expense.received-expense' },
];

// A cent of difference is rounding, not a mismatch; compared in whole cents
// because 78.18 - 78.17 is 0.010000000000005 in floating point.
const differs = (base, assigned) => Math.round(Math.abs(base - assigned) * 100) > 1;
const CHUNK = 500;

const keyOf = (link) => `${link.line}#${link.field}`;
const refId = (value) => (value && typeof value === 'object' ? value.id : value) || null;

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** The documents linked to the lines matching `where`, as { key: Set(ids) }. */
async function documentsOfLines(where) {
  const docs = {};
  for (const link of LINKS) {
    const rows = await strapi.db.query(link.line).findMany({
      where: { ...where, [link.field]: { id: { $notNull: true } } },
      select: ['id'],
      populate: { [link.field]: { select: ['id'] } },
    });
    docs[keyOf(link)] = new Set(rows.map((r) => refId(r[link.field])).filter(Boolean));
  }
  return docs;
}

/** The documents linked to the execution lines of a project. */
const documentsOfProject = (projectId) => documentsOfLines({ project_phase: { project: { id: projectId } } });

function mergeDocuments(...sets) {
  const out = {};
  for (const set of sets) {
    for (const [key, ids] of Object.entries(set || {})) {
      out[key] = new Set([...(out[key] || []), ...ids]);
    }
  }
  return out;
}

/** Recompute `warning` on every execution line of the given documents. */
async function refreshLineWarnings(docs) {
  let changed = 0;
  for (const link of LINKS) {
    const ids = [...((docs && docs[keyOf(link)]) || [])];
    for (const part of chunks(ids)) {
      const documents = await strapi.db.query(link.doc).findMany({
        where: { id: { $in: part } },
        select: ['id', 'total_base'],
      });
      const lines = await strapi.db.query(link.line).findMany({
        where: { [link.field]: { id: { $in: part } }, project_phase: { id: { $notNull: true } } },
        select: ['id', 'quantity', 'amount', 'warning'],
        populate: { [link.field]: { select: ['id'] } },
      });

      const assigned = new Map();
      for (const line of lines) {
        const docId = refId(line[link.field]);
        assigned.set(docId, (assigned.get(docId) || 0) + (Number(line.quantity) || 0) * (Number(line.amount) || 0));
      }
      const warns = new Map(
        documents.map((d) => [d.id, differs(Number(d.total_base) || 0, assigned.get(d.id) || 0)]),
      );

      const set = { true: [], false: [] };
      for (const line of lines) {
        const docId = refId(line[link.field]);
        if (!warns.has(docId)) continue;
        const warning = warns.get(docId);
        if (line.warning !== warning) set[warning].push(line.id);
      }
      for (const warning of [true, false]) {
        if (set[warning].length === 0) continue;
        await strapi.db.query(link.line).updateMany({ where: { id: { $in: set[warning] } }, data: { warning } });
        changed += set[warning].length;
      }
    }
  }
  return changed;
}

/** Startup script: recompute the warning of every linked execution line. */
async function refreshAllLineWarnings() {
  const docs = await documentsOfLines({ project_phase: { id: { $notNull: true } } });
  const changed = await refreshLineWarnings(docs);
  strapi.log.info(`[refreshAllLineWarnings] ${changed} project lines changed their «Imports diferents» warning`);
}

module.exports = {
  LINKS,
  documentsOfLines,
  documentsOfProject,
  mergeDocuments,
  refreshLineWarnings,
  refreshAllLineWarnings,
};
