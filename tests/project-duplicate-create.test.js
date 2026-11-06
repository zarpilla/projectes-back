'use strict';

/**
 * 2026-11-06: «Duplicar projecte» › «Confirmar duplicat» answered «S'ha produït
 * un error al guardar el projecte: Invalid key project_phases_info». The copy
 * is a POST /projects with the whole form: the update's control fields
 * (`project_phases_info`, `_project_phases_updated`) reached v5's input
 * validation, and the phases still carried the source's documentIds, which the
 * core create would take as links to the source's rows. The create now takes
 * them out of the request and creates the phases and their lines as new rows.
 */

describe('POST /projects with the phases of a duplicated project', () => {
  let controller;
  let superCreate;
  let created;

  beforeEach(() => {
    jest.resetModules();
    created = { phases: [], incomes: [], expenses: [], hours: [] };
    let nextId = 100;
    superCreate = jest.fn(async () => ({ data: { id: 7, documentId: 'new-doc' } }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, build) =>
          Object.setPrototypeOf(build({ strapi: global.strapi }), { create: superCreate }),
      },
    }));
    const sink = {
      'api::project-phase.project-phase': created.phases,
      'api::project-original-phase.project-original-phase': created.phases,
      'api::phase-income.phase-income': created.incomes,
      'api::phase-expense.phase-expense': created.expenses,
      'api::estimated-hour.estimated-hour': created.hours,
    };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: {
        transaction: async (fn) => fn(),
        query: (uid) => ({
          create: async ({ data }) => {
            const row = { id: nextId++, ...data, uid };
            sink[uid].push(row);
            return row;
          },
        }),
      },
      controller: () => controller,
    };
    controller = require('../src/api/project/controllers/project');
  });

  afterEach(() => {
    delete global.strapi;
    jest.dontMock('@strapi/strapi');
  });

  const phase = (name, position) => ({
    documentId: `src-phase-${name}`,
    name,
    position,
    dirty: true,
    incomes: [
      {
        documentId: 'src-income',
        concept: 'Ingrés',
        quantity: 10,
        amount: 50,
        position: 0,
        dirty: true,
        estimated_hours: [{ documentId: 'src-hour', _uuid: 'x', quantity: 3, users_permissions_user: 4 }],
      },
    ],
    expenses: [{ documentId: 'src-expense', concept: 'Despesa', quantity: 2, amount: 30, dirty: true }],
  });

  const ctx = () => ({
    params: {},
    query: {},
    state: {},
    request: {
      body: {
        data: {
          name: 'Còpia',
          billing_mode: 'project',
          project_phases: [phase('A', 0), phase('B', 1)],
          project_original_phases: [phase('A', 0)],
          project_phases_info: { deletedPhases: [] },
          project_original_phases_info: { deletedPhases: [] },
          _project_phases_updated: true,
        },
      },
    },
    badRequest: jest.fn((message) => ({ status: 400, message })),
  });

  it('sends the core create no control fields and no phases', async () => {
    const c = ctx();
    await controller.create(c);
    expect(superCreate).toHaveBeenCalledTimes(1);
    expect(Object.keys(c.request.body.data).sort()).toEqual(['billing_mode', 'name']);
  });

  it('creates the phases, lines and hours as new rows of the new project', async () => {
    const res = await controller.create(ctx());
    expect(res.data.id).toBe(7);
    expect(created.phases.map((p) => [p.uid.split('.')[1], p.name, p.position, p.project])).toEqual([
      ['project-phase', 'A', 0, 7],
      ['project-phase', 'B', 1, 7],
      ['project-original-phase', 'A', 0, 7],
    ]);
    expect(created.incomes).toHaveLength(3);
    expect(created.expenses).toHaveLength(3);
    expect(created.hours).toHaveLength(3);
    for (const row of [...created.incomes, ...created.expenses, ...created.hours]) {
      expect(row.documentId).toBeUndefined();
      expect(row.dirty).toBeUndefined();
      expect(row._uuid).toBeUndefined();
    }
    expect(created.incomes[0]).toMatchObject({ concept: 'Ingrés', total_amount: 500, project_phase: created.phases[0].id });
    expect(created.hours[0]).toMatchObject({ quantity: 3, users_permissions_user: 4, phase_income: created.incomes[0].id });
  });

  it('a project without phases is a plain core create', async () => {
    const c = ctx();
    delete c.request.body.data.project_phases;
    delete c.request.body.data.project_original_phases;
    await controller.create(c);
    expect(superCreate).toHaveBeenCalledTimes(1);
    expect(created.phases).toHaveLength(0);
    expect(c.request.body.data.project_phases_info).toBeUndefined();
  });
});
