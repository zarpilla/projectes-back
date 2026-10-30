'use strict';

/**
 * GET /api/contacts/:id/summary — the «Resum» tab of a contact: the projects
 * it takes part in and its documents, so the office sees what it has done with
 * a client or a provider without going through every list (decided
 * 2026-10-30: projects as client or intercooperation, quotes, invoices,
 * incomes and expenses; no grants, no planned figures).
 *
 * Only the rows the tab shows, with their own fields: the figures per period
 * are summed in the front (domain/contactSummary.js), where the year selector
 * is. A delivery point (a contact with an owner) gets no summary: its tab is
 * the orders one, in its own form.
 */

const PROJECT_FIELDS = ['id', 'name', 'date_start', 'date_end', 'trashed'];
const PROJECT_POPULATE = { project_state: { select: ['id', 'name'] } };

// kind → content type and the fields its rows need
const DOCUMENTS = {
  'quotes': {
    uid: 'api::quote.quote',
    relation: 'project',
    select: ['id', 'code', 'emitted', 'total_base', 'total', 'accepted', 'accepted_date'],
  },
  'emitted-invoices': {
    uid: 'api::emitted-invoice.emitted-invoice',
    relation: 'projects',
    select: ['id', 'code', 'emitted', 'paybefore', 'total_base', 'total', 'paid', 'paid_date', 'state', 'concept'],
  },
  'received-incomes': {
    uid: 'api::received-income.received-income',
    relation: 'projects',
    select: ['id', 'code', 'emitted', 'paybefore', 'total_base', 'total', 'paid', 'paid_date'],
  },
  'received-invoices': {
    uid: 'api::received-invoice.received-invoice',
    relation: 'projects',
    select: ['id', 'code', 'emitted', 'paybefore', 'total_base', 'total', 'paid', 'paid_date'],
  },
  'received-expenses': {
    uid: 'api::received-expense.received-expense',
    relation: 'projects',
    select: ['id', 'code', 'emitted', 'paybefore', 'total_base', 'total', 'paid', 'paid_date'],
  },
};

// A quote has one project; invoices, incomes and expenses keep theirs in
// `projects` (their `project` is empty in every tenant) and a few are shared
// between several projects.
const docProjects = (d, relation) => {
  const value = d[relation];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((p) => ({ id: p.id, name: p.name }));
};

function projectRow(project, role) {
  const { trashed, project_state: state, ...rest } = project;
  return { ...rest, state: state ? { id: state.id, name: state.name } : null, roles: [role] };
}

/**
 * Projects as client, as intercooperation and with documents of the contact
 * (an invoice is often on a project where the contact is not set as client),
 * one row per project, trashed ones left out.
 */
function mergeProjects(asClient, asIntercoop, withDocuments = []) {
  const byId = new Map();
  for (const [list, role] of [[asClient, 'client'], [asIntercoop, 'intercooperation'], [withDocuments, 'documents']]) {
    for (const p of list || []) {
      if (p.trashed) continue;
      const row = byId.get(p.id);
      if (row) {
        if (!row.roles.includes(role)) row.roles.push(role);
      } else {
        byId.set(p.id, projectRow(p, role));
      }
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(b.date_start || '').localeCompare(String(a.date_start || '')) || b.id - a.id
  );
}

async function contactSummary(strapi, id) {
  const contactId = Number(id);
  if (!Number.isInteger(contactId) || contactId <= 0) return null;
  const contact = await strapi.db.query('api::contact.contact').findOne({
    where: { id: contactId },
    select: ['id', 'name', 'trade_name', 'nif'],
    populate: { owner: { select: ['id'] } },
  });
  if (!contact) return null;
  const header = { id: contact.id, name: contact.name, trade_name: contact.trade_name, nif: contact.nif };
  if (contact.owner) return { contact: { ...header, delivery_point: true }, projects: [], documents: [] };

  const projects = strapi.db.query('api::project.project');
  const [asClient, asIntercoop, ...docLists] = await Promise.all([
    projects.findMany({ select: PROJECT_FIELDS, where: { clients: { id: contactId } }, populate: PROJECT_POPULATE }),
    projects.findMany({ select: PROJECT_FIELDS, where: { intercooperations: { id: contactId } }, populate: PROJECT_POPULATE }),
    ...Object.values(DOCUMENTS).map(({ uid, select, relation }) =>
      strapi.db.query(uid).findMany({
        select,
        where: { contact: { id: contactId } },
        populate: { [relation]: { select: ['id', 'name'] } },
      })
    ),
  ]);

  const documents = Object.entries(DOCUMENTS).flatMap(([kind, { relation }], i) =>
    (docLists[i] || []).map(({ project, projects: list, ...d }) => ({
      ...d,
      kind,
      projects: docProjects({ project, projects: list }, relation),
    }))
  );
  documents.sort((a, b) => String(b.emitted || '').localeCompare(String(a.emitted || '')) || b.id - a.id);

  const linked = new Set([...asClient, ...asIntercoop].map((p) => p.id));
  const otherIds = [...new Set(documents.flatMap((d) => d.projects.map((p) => p.id)))].filter((pid) => !linked.has(pid));
  const withDocuments = otherIds.length
    ? await projects.findMany({ select: PROJECT_FIELDS, where: { id: { $in: otherIds } }, populate: PROJECT_POPULATE })
    : [];

  return { contact: header, projects: mergeProjects(asClient, asIntercoop, withDocuments), documents };
}

module.exports = { contactSummary, mergeProjects, DOCUMENTS };
