'use strict';

/**
 * The documents of a project as ProjectForm lists them (issues/120).
 *
 * The form reads `emitted_invoices`, `received_invoices`, `received_incomes`
 * and `received_expenses`: on the project these are the legacy one-to-many
 * relations (`document.project`), which v5 data barely uses. Documents are
 * linked through their many-to-many `projects` relation, which the project
 * sees as `linked_*`. Both are answered under the legacy names, once each,
 * with `contact` and `document_type` as ids (what the form compares).
 */
const LINKED = {
  emitted_invoices: 'linked_emitted_invoices',
  received_invoices: 'linked_received_invoices',
  received_incomes: 'linked_received_incomes',
  received_expenses: 'linked_received_expenses',
};

// populate entries for findOne
const LINKED_POPULATE = Object.values(LINKED).flatMap((rel) => [rel, `${rel}.contact`, `${rel}.document_type`]);

const idOf = (value) => (value && typeof value === 'object' ? value.id : value === undefined ? null : value);

function mergeLinkedDocuments(project) {
  for (const [field, linked] of Object.entries(LINKED)) {
    const byId = new Map();
    for (const doc of [...(project[field] || []), ...(project[linked] || [])]) {
      if (!doc || byId.has(doc.id)) continue;
      const out = { ...doc, contact: idOf(doc.contact) };
      if ('document_type' in doc) out.document_type = idOf(doc.document_type);
      byId.set(doc.id, out);
    }
    project[field] = [...byId.values()];
    delete project[linked];
  }
  return project;
}

module.exports = { LINKED_POPULATE, mergeLinkedDocuments };
