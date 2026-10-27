/**
 * issues/345 (2026-10-26): the lines of a project's budget can be reordered
 * with drag & drop, and the order has to stay after saving. The form sends the
 * lines in their new order; updatePhases stores each line's index in
 * `position`. Lines that only moved are written with updateMany (no lifecycle:
 * the order changes no total); new and edited lines carry it in their own write.
 */

const { assignLinePositions } = require('../src/services/budget-line');

describe('assignLinePositions', () => {
  it('numbers the lines in order and returns the saved ones that only moved', () => {
    const lines = [
      { id: 2, position: 1 },
      { id: 1, position: 0 },
      { id: 3, position: 2 },
      { concept: 'new' },
      { id: 4, position: 0, dirty: true },
    ];
    expect(assignLinePositions(lines)).toEqual([
      { id: 2, position: 0 },
      { id: 1, position: 1 },
    ]);
    expect(lines.map((l) => l.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('writes the lines that never had a position', () => {
    expect(assignLinePositions([{ id: 1 }, { id: 2, position: null }])).toEqual([
      { id: 1, position: 0 },
      { id: 2, position: 1 },
    ]);
  });

  it('accepts a missing list', () => {
    expect(assignLinePositions(undefined)).toEqual([]);
  });
});

describe('updatePhases stores the line order', () => {
  let controller;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    calls = [];
    const query = (uid) => ({
      create: async (args) => {
        calls.push({ uid, op: 'create', args });
        return { id: 999 };
      },
      update: async (args) => calls.push({ uid, op: 'update', args }),
      updateMany: async (args) => calls.push({ uid, op: 'updateMany', args }),
      deleteMany: async (args) => calls.push({ uid, op: 'deleteMany', args }),
      findMany: async () => [],
    });
    global.strapi = { db: { query } };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('saves the new position of moved lines, and the position of new and edited ones', async () => {
    const phases = [
      {
        id: 10,
        incomes: [
          { id: 101, concept: 'b', quantity: 1, amount: 2, position: 1 },
          { id: 100, concept: 'a', quantity: 1, amount: 1, position: 0 },
          { concept: 'new', quantity: 1, amount: 3 },
        ],
        expenses: [
          { id: 201, concept: 'y', quantity: 1, amount: 5, position: 1, dirty: true },
          { id: 200, concept: 'x', quantity: 1, amount: 4, position: 0 },
        ],
      },
    ];

    await controller.updatePhases(7, 'project-phases', phases, [], [], [], []);

    const positionWrites = calls
      .filter((c) => c.op === 'updateMany')
      .map((c) => [c.uid, c.args.where.id, c.args.data.position]);
    expect(positionWrites).toEqual([
      ['api::phase-income.phase-income', 101, 0],
      ['api::phase-income.phase-income', 100, 1],
      ['api::phase-expense.phase-expense', 200, 1],
    ]);

    const created = calls.find((c) => c.op === 'create' && c.uid === 'api::phase-income.phase-income');
    expect(created.args.data).toMatchObject({ concept: 'new', position: 2, project_phase: 10 });

    const edited = calls.find((c) => c.op === 'update' && c.uid === 'api::phase-expense.phase-expense');
    expect(edited.args).toMatchObject({ where: { id: 201 }, data: { position: 0 } });
  });

  it('writes nothing for lines already in place', async () => {
    const phases = [
      {
        id: 10,
        incomes: [
          { id: 100, concept: 'a', quantity: 1, amount: 1, position: 0 },
          { id: 101, concept: 'b', quantity: 1, amount: 2, position: 1 },
        ],
        expenses: [],
      },
    ];
    await controller.updatePhases(7, 'project-phases', phases, [], [], [], []);
    expect(calls).toEqual([]);
  });
});
