/**
 * issues/120: the project form lists the project's documents from
 * `emitted_invoices`, `received_invoices`, `received_incomes` and
 * `received_expenses`. Those are the legacy one-to-many relations
 * (`document.project`), empty in v5 data: the documents are linked through
 * the many-to-many `projects` relation (`linked_*` on the project). findOne
 * answers both, under the names the form reads, with the contact and the
 * document type as ids.
 */

describe('project findOne documents (issues/120)', () => {
  let controller;
  let populated;

  const storedProject = () => ({
    id: 7,
    name: 'Project',
    activities: [],
    project_phases: [],
    project_original_phases: [],
    emitted_invoices: [{ id: 1, code: '2025-001', emitted: '2025-01-10', total_base: 100, contact: { id: 9 } }],
    received_invoices: [],
    received_incomes: [],
    received_expenses: [],
    linked_emitted_invoices: [
      { id: 1, code: '2025-001', emitted: '2025-01-10', total_base: 100, contact: { id: 9 } },
      { id: 2, code: '2025-042', emitted: '2025-05-13', total_base: 6.38, contact: { id: 9 } },
    ],
    linked_received_invoices: [{ id: 5, code: 'R-1', emitted: '2025-02-01', total_base: 50, contact: null }],
    linked_received_incomes: [{ id: 6, emitted: '2025-03-01', total_base: 20, contact: { id: 4 }, document_type: { id: 3 } }],
    linked_received_expenses: [{ id: 8, emitted: '2025-04-01', total_base: 10, contact: { id: 4 }, document_type: null }],
  });

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    jest.doMock('../src/api/project/services/projectCache', () => ({
      getDailyDedications: async () => [],
      getFestives: async () => [],
    }));
    global.strapi = {
      db: {
        query: () => ({
          findOne: async (args) => { populated = args.populate; return storedProject(); },
          findMany: async () => [],
          count: async () => 0,
        }),
      },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ctx = { params: { id: 7 }, state: {}, query: { _phases: 'false' } };

  it('loads the many-to-many documents with their contact and type', async () => {
    await controller.findOne(ctx);
    const keys = JSON.stringify(populated);
    for (const rel of ['linked_emitted_invoices', 'linked_received_invoices', 'linked_received_incomes', 'linked_received_expenses']) {
      expect(keys).toContain(rel);
    }
  });

  it('answers them under the names the form reads, once each, with ids for contact and type', async () => {
    const project = await controller.findOne(ctx);
    expect(project.emitted_invoices.map((d) => d.id)).toEqual([1, 2]);
    expect(project.emitted_invoices[1]).toMatchObject({ code: '2025-042', contact: 9 });
    expect(project.received_invoices).toEqual([expect.objectContaining({ id: 5, contact: null })]);
    expect(project.received_incomes[0]).toMatchObject({ id: 6, contact: 4, document_type: 3 });
    expect(project.received_expenses[0]).toMatchObject({ id: 8, document_type: null });
    expect(project).not.toHaveProperty('linked_emitted_invoices');
  });
});
