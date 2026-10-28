/**
 * Phases of a project can be reordered with drag & drop, like their lines
 * (issues/345). updatePhases stores each phase's index in `position`; every
 * endpoint that hands phases to the front returns them (and their lines) in
 * that order, so a form that saves them back without showing them keeps it.
 */

const { sortByPosition, sortPhasesByPosition } = require('../src/services/budget-line');

describe('sortByPosition', () => {
  it('puts the rows with a position first, the others after in the order they came', () => {
    const rows = [{ id: 1 }, { id: 2, position: 1 }, { id: 3, position: null }, { id: 4, position: 0 }];
    expect(sortByPosition(rows).map((r) => r.id)).toEqual([4, 2, 1, 3]);
  });

  it('accepts a missing list', () => {
    expect(sortByPosition(undefined)).toBeUndefined();
  });
});

describe('sortPhasesByPosition', () => {
  it('sorts the phases and the lines of each one', () => {
    const phases = [
      { id: 1, position: 1, incomes: [{ id: 11, position: 1 }, { id: 10, position: 0 }], expenses: [] },
      { id: 2, position: 0, incomes: [], expenses: [{ id: 21, position: 1 }, { id: 20, position: 0 }] },
    ];
    sortPhasesByPosition(phases);
    expect(phases.map((p) => p.id)).toEqual([2, 1]);
    expect(phases[0].expenses.map((l) => l.id)).toEqual([20, 21]);
    expect(phases[1].incomes.map((l) => l.id)).toEqual([10, 11]);
  });
});

describe('updatePhases stores the phase order', () => {
  let controller;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    calls = [];
    let nextId = 900;
    const query = (uid) => ({
      create: async (args) => {
        calls.push({ uid, op: 'create', args });
        return { id: nextId++ };
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

  it('saves the new position of moved phases, and the position of new and renamed ones', async () => {
    const phases = [
      { id: 2, name: 'B', position: 1, incomes: [], expenses: [] },
      { id: 1, name: 'A', position: 0, incomes: [], expenses: [] },
      { name: 'Nova', incomes: [], expenses: [], dirty: true },
      { id: 3, name: 'C reanomenada', position: 2, incomes: [], expenses: [], dirty: true },
    ];

    await controller.updatePhases(7, 'project-original-phases', phases, [], [], [], []);

    const uid = 'api::project-original-phase.project-original-phase';
    const moved = calls
      .filter((c) => c.op === 'updateMany' && c.uid === uid)
      .map((c) => [c.args.where.id, c.args.data.position]);
    expect(moved).toEqual([
      [2, 0],
      [1, 1],
    ]);
    const created = calls.find((c) => c.op === 'create' && c.uid === uid);
    expect(created.args.data).toEqual({ project: 7, name: 'Nova', position: 2 });
    const renamed = calls.find((c) => c.op === 'update' && c.uid === uid);
    expect(renamed.args).toEqual({ where: { id: 3 }, data: { project: 7, name: 'C reanomenada', position: 3 } });
    expect(phases.map((p) => p.position)).toEqual([0, 1, 2, 3]);
  });

  it('writes nothing for phases already in place', async () => {
    const phases = [
      { id: 1, name: 'A', position: 0, incomes: [], expenses: [] },
      { id: 2, name: 'B', position: 1, incomes: [], expenses: [] },
    ];
    await controller.updatePhases(7, 'project-phases', phases, [], [], [], []);
    expect(calls).toEqual([]);
  });
});
