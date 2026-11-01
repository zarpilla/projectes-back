'use strict';

/**
 * «Resum» tab of a contact (decided 2026-10-30): the contact form showed no
 * projects nor documents of the contact. GET /contacts/:id/summary answers its
 * projects (as client or intercooperation, no grants) and its quotes, invoices,
 * incomes and expenses. A delivery point gets none: Diligència's points keep
 * their own form.
 */

const { contactSummary, mergeProjects, projectHours } = require('../src/api/contact/services/contact-summary');

// the chain of the grouped activities query; `whereIn` records the projects asked for
function hoursQuery(rows, asked) {
  const chain = { join: () => chain, groupBy: () => chain, select: async () => rows };
  chain.whereIn = (column, ids) => {
    asked.push(...ids);
    return chain;
  };
  return chain;
}

function stubStrapi({ contact, clients = [], intercoops = [], docs = {}, docProjects = [], children = [], hourRows = [] }) {
  const calls = [];
  const asked = [];
  const query = (uid) => ({
    findOne: jest.fn(async () => contact),
    findMany: jest.fn(async (opts) => {
      calls.push({ uid, opts });
      if (uid === 'api::project.project') {
        if (opts.where.mother) return children;
        if (opts.where.id) return docProjects.filter((p) => opts.where.id.$in.includes(p.id));
        return opts.where.clients ? clients : intercoops;
      }
      return docs[uid] || [];
    }),
  });
  const connection = () => hoursQuery(hourRows, asked);
  connection.raw = (sql) => sql;
  const metadata = {
    get: () => ({
      tableName: 'activities',
      attributes: {
        project: {
          joinTable: {
            name: 'activities_project_lnk',
            joinColumn: { name: 'activity_id' },
            inverseJoinColumn: { name: 'project_id' },
          },
        },
      },
    }),
  };
  return { strapi: { db: { query, metadata, connection } }, calls, asked };
}

describe('mergeProjects', () => {
  it('gives one row per project with every role, newest first, trashed left out', () => {
    const rows = mergeProjects(
      [
        { id: 1, name: 'A', date_start: '2025-01-01', project_state: { id: 2, name: 'En curs', color: 'x' } },
        { id: 2, name: 'B', date_start: '2026-03-01', trashed: true },
      ],
      [
        { id: 1, name: 'A', date_start: '2025-01-01' },
        { id: 3, name: 'C', date_start: '2026-01-01', project_state: null },
      ]
    );
    expect(rows.map((r) => [r.id, r.roles])).toEqual([
      [3, ['intercooperation']],
      [1, ['client', 'intercooperation']],
    ]);
    expect(rows[1].state).toEqual({ id: 2, name: 'En curs' });
    expect(rows[1]).not.toHaveProperty('trashed');
  });
});

describe('contactSummary', () => {
  it('answers null for an unknown or invalid id', async () => {
    const { strapi } = stubStrapi({ contact: null });
    expect(await contactSummary(strapi, 9)).toBeNull();
    expect(await contactSummary(strapi, 'abc')).toBeNull();
  });

  it('gives a delivery point no projects nor documents, without querying them', async () => {
    const { strapi, calls } = stubStrapi({ contact: { id: 4, name: 'Punt', owner: { id: 7 } } });
    const summary = await contactSummary(strapi, 4);
    expect(summary.contact.delivery_point).toBe(true);
    expect(summary.projects).toEqual([]);
    expect(summary.documents).toEqual([]);
    expect(summary.hours).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers the projects and every document kind, newest first, with its project', async () => {
    const { strapi, calls } = stubStrapi({
      contact: { id: 5, name: 'Coop', trade_name: 'Coop SCCL', nif: 'F1', owner: null },
      clients: [{ id: 1, name: 'Web', date_start: '2026-01-01' }],
      docProjects: [{ id: 2, name: 'App', date_start: '2025-01-01' }],
      docs: {
        'api::emitted-invoice.emitted-invoice': [
          { id: 10, code: 'F-1', emitted: '2026-02-01', total: 121, projects: [{ id: 1, name: 'Web', leader: {} }, { id: 2, name: 'App' }] },
        ],
        'api::quote.quote': [
          { id: 20, code: 'P-1', emitted: '2026-01-10', total: 500, project: null },
          { id: 21, code: 'P-0', emitted: '2026-01-01', total: 50, project: { id: 1, name: 'Web' } },
        ],
        'api::received-invoice.received-invoice': [{ id: 30, code: 'R-1', emitted: '2026-03-01', total: 50 }],
      },
    });
    const summary = await contactSummary(strapi, '5');
    expect(summary.contact).toEqual({ id: 5, name: 'Coop', trade_name: 'Coop SCCL', nif: 'F1' });
    // project 2 only through an invoice: listed with the role «documents»
    expect(summary.projects.map((p) => [p.id, p.roles])).toEqual([[1, ['client']], [2, ['documents']]]);
    const byIds = calls.find((c) => c.uid === 'api::project.project' && c.opts.where.id);
    expect(byIds.opts.where.id.$in).toEqual([2]);
    expect(summary.documents.map((d) => [d.kind, d.id])).toEqual([
      ['received-invoices', 30],
      ['emitted-invoices', 10],
      ['quotes', 20],
      ['quotes', 21],
    ]);
    // invoices keep their projects in `projects`, a quote in `project`
    expect(summary.documents[1].projects).toEqual([{ id: 1, name: 'Web' }, { id: 2, name: 'App' }]);
    expect(summary.documents[2].projects).toEqual([]);
    expect(summary.documents[3].projects).toEqual([{ id: 1, name: 'Web' }]);
    expect(summary.documents[3]).not.toHaveProperty('project');

    const docCalls = calls.filter((c) => c.uid !== 'api::project.project');
    expect(docCalls.map((c) => c.uid).sort()).toEqual([
      'api::emitted-invoice.emitted-invoice',
      'api::quote.quote',
      'api::received-expense.received-expense',
      'api::received-income.received-income',
      'api::received-invoice.received-invoice',
    ]);
    for (const c of docCalls) expect(c.opts.where).toEqual({ contact: { id: 5 } });
    const populates = Object.fromEntries(docCalls.map((c) => [c.uid, Object.keys(c.opts.populate)]));
    expect(populates['api::quote.quote']).toEqual(['project']);
    expect(populates['api::emitted-invoice.emitted-invoice']).toEqual(['projects']);
  });

  it('answers the hours of its projects', async () => {
    const { strapi } = stubStrapi({
      contact: { id: 5, name: 'Coop', owner: null },
      clients: [{ id: 1, name: 'Web' }],
      hourRows: [{ project_id: 1, y: 2026, m: 3, hours: '7.50' }],
    });
    const summary = await contactSummary(strapi, 5);
    expect(summary.hours).toEqual([{ project: 1, projects: [1], date: '2026-03-01', hours: 7.5 }]);
  });

  it('selects only fields the content types have', () => {
    const { DOCUMENTS } = require('../src/api/contact/services/contact-summary');
    for (const { uid, select, relation } of Object.values(DOCUMENTS)) {
      const name = uid.split('.').pop();
      const attrs = require(`../src/api/${name}/content-types/${name}/schema.json`).attributes;
      for (const f of [...select, relation]) if (f !== 'id') expect([uid, f, !!attrs[f]]).toEqual([uid, f, true]);
    }
  });
});

describe('projectHours', () => {
  it('asks nothing without projects', async () => {
    const { strapi, calls } = stubStrapi({});
    expect(await projectHours(strapi, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('gives a mother the hours of its live children instead of its own (issues/172)', async () => {
    const { strapi, asked } = stubStrapi({
      children: [
        { id: 2, mother: { id: 1 } },
        { id: 3, mother: { id: 1 } },
        { id: 4, mother: { id: 1 }, trashed: true },
      ],
      hourRows: [
        { project_id: 2, y: 2026, m: 1, hours: '2.00' }, // also listed itself
        { project_id: 3, y: 2026, m: 1, hours: '3.00' }, // only reached through its mother
        { project_id: 5, y: 2025, m: 12, hours: '1.00' }, // no children
      ],
    });
    const rows = await projectHours(strapi, [{ id: 1 }, { id: 2 }, { id: 5 }]);
    expect(asked.sort()).toEqual([2, 3, 5]);
    expect(rows).toEqual([
      { project: 2, projects: [2, 1], date: '2026-01-01', hours: 2 },
      { project: 3, projects: [1], date: '2026-01-01', hours: 3 },
      { project: 5, projects: [5], date: '2025-12-01', hours: 1 },
    ]);
  });

  it('keeps the own hours of a project whose children are all trashed', async () => {
    const { strapi, asked } = stubStrapi({ children: [{ id: 4, mother: { id: 1 }, trashed: true }] });
    await projectHours(strapi, [{ id: 1 }]);
    expect(asked).toEqual([1]);
  });

  it('keeps undated activities apart, with no date', async () => {
    const { strapi } = stubStrapi({ hourRows: [{ project_id: 1, y: null, m: null, hours: 4 }] });
    expect(await projectHours(strapi, [{ id: 1 }])).toEqual([{ project: 1, projects: [1], date: null, hours: 4 }]);
  });
});
