'use strict';

/**
 * The documents a project's budget lines point at, for the Tresoreria
 * forecast (issues/328).
 *
 * The forecast kept its projects in the read cache with each line's document
 * populated, so every new invoice, expense or income (a write to the document
 * table) dropped the whole projects piece, the heaviest one. Now the projects
 * are read without those documents, and the links (line id → document id) are
 * read from the link tables alone. Each request puts the documents back on the
 * lines from the forecast's own document pieces, which hold every row of those
 * tables. Lines with a document become shallow copies; everything else is the
 * cached, frozen object.
 */

/** relation of a budget line → where its document comes from */
const PHASE_DOCUMENT_RELATIONS = [
  { line: 'api::phase-expense.phase-expense', side: 'expenses', field: 'invoice', docs: 'received' },
  { line: 'api::phase-expense.phase-expense', side: 'expenses', field: 'expense', docs: 'receivedExpenses' },
  { line: 'api::phase-income.phase-income', side: 'incomes', field: 'invoice', docs: 'emitted' },
  { line: 'api::phase-income.phase-income', side: 'incomes', field: 'income', docs: 'receivedIncomes' },
];

/** The link table of each relation: { table, lineColumn, docColumn }. */
function phaseDocumentLinkTables(strapi) {
  return PHASE_DOCUMENT_RELATIONS.map((r) => {
    const attr = strapi.db.metadata.get(r.line).attributes[r.field];
    const jt = attr && attr.joinTable;
    if (!jt || !jt.name || !jt.joinColumn || !jt.inverseJoinColumn) {
      throw new Error(`phase-documents: no link table for ${r.line}.${r.field}`);
    }
    return { ...r, table: jt.name, lineColumn: jt.joinColumn.name, docColumn: jt.inverseJoinColumn.name };
  });
}

/**
 * Reads the links: `{ 'expenses.invoice': [[lineId, docId], ...], ... }`
 * (plain arrays: the read cache keeps plain data only).
 */
async function loadPhaseDocumentLinks(strapi) {
  const out = {};
  for (const r of phaseDocumentLinkTables(strapi)) {
    const rows = await strapi.db.connection(r.table).select(r.lineColumn, r.docColumn);
    out[`${r.side}.${r.field}`] = rows.map((row) => [row[r.lineColumn], row[r.docColumn]]);
  }
  return out;
}

/**
 * The projects with each line's documents set, as `populate` gave them: the
 * document, or null when the line has none.
 * @param {object[]} projects frozen, read without the documents
 * @param {object} links from loadPhaseDocumentLinks
 * @param {{ received: object[], receivedExpenses: object[], emitted: object[], receivedIncomes: object[] }} docs
 */
function withPhaseDocuments(projects, links, docs) {
  // per side: line id -> { field: document }
  const bySide = { expenses: new Map(), incomes: new Map() };
  for (const r of PHASE_DOCUMENT_RELATIONS) {
    const byId = new Map((docs[r.docs] || []).map((d) => [d.id, d]));
    for (const [lineId, docId] of links[`${r.side}.${r.field}`] || []) {
      const doc = byId.get(docId);
      if (!doc) continue; // deleted meanwhile: populate would give null
      const map = bySide[r.side];
      if (!map.has(lineId)) map.set(lineId, {});
      map.get(lineId)[r.field] = doc;
    }
  }
  const fields = (side) => PHASE_DOCUMENT_RELATIONS.filter((r) => r.side === side).map((r) => r.field);
  const lineWith = (side) => (line) => {
    const found = bySide[side].get(line.id) || {};
    const extra = {};
    // a line read without its documents has none of these fields; one that
    // already holds its document keeps it
    for (const f of fields(side)) extra[f] = found[f] || line[f] || null;
    return { ...line, ...extra };
  };
  return projects.map((p) => {
    if (!Array.isArray(p.project_phases) || !p.project_phases.length) return p;
    return {
      ...p,
      project_phases: p.project_phases.map((ph) => ({
        ...ph,
        ...(Array.isArray(ph.expenses) ? { expenses: ph.expenses.map(lineWith('expenses')) } : {}),
        ...(Array.isArray(ph.incomes) ? { incomes: ph.incomes.map(lineWith('incomes')) } : {}),
      })),
    };
  });
}

module.exports = {
  PHASE_DOCUMENT_RELATIONS,
  phaseDocumentLinkTables,
  loadPhaseDocumentLinks,
  withPhaseDocuments,
};
