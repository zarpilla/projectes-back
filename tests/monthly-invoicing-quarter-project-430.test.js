'use strict';

/**
 * issues/430: the logistics project of a quarter, one rule for «Facturar» and
 * the automatic invoicing: the project named after the quarter (the dates
 * don't count), the one with the option first; and its creation in a click,
 * modelled on the last one, with one phase «Logística».
 */

const q = require('../src/services/monthly-invoicing/quarter-project');

describe('the quarter of a logistics project name (issues/430)', () => {
  it('reads the names la Diligència uses', () => {
    expect(q.projectQuarter('3T 2026 - Logística')).toEqual({ year: 2026, quarter: 3 });
    expect(q.projectQuarter('Logística - 2025 - 2T')).toEqual({ year: 2025, quarter: 2 });
    expect(q.projectQuarter('2025 4T - Logística')).toEqual({ year: 2025, quarter: 4 });
    expect(q.projectQuarter('LOGÍSTICA - 2024 - 3T')).toEqual({ year: 2024, quarter: 3 });
    expect(q.projectQuarter('Logística 2025 - 2T*')).toEqual({ year: 2025, quarter: 2 });
    expect(q.projectQuarter('Logística - 2024')).toBeNull();
    expect(q.projectQuarter('Formació 1T 2026')).toBeNull();
  });

  it('the quarter of a month, with its dates', () => {
    expect(q.quarterOf('2026-11')).toEqual({ year: 2026, quarter: 4, label: '4T 2026', date_start: '2026-10-01', date_end: '2026-12-31' });
    expect(q.quarterOf('2027-02')).toMatchObject({ label: '1T 2027', date_start: '2027-01-01', date_end: '2027-03-31' });
    expect(q.quarterOf('2026-06')).toMatchObject({ date_start: '2026-04-01', date_end: '2026-06-30' });
  });
});

describe("the quarter's project (issues/430)", () => {
  // la Diligència's, as they are: overlapping dates, several names
  const projects = [
    { id: 21, name: 'Logística - 2025 - 2T', phases: 1 },
    { id: 22, name: 'Logística 2025 - 2T*', phases: 0 },
    { id: 25, name: '1T 2026 - Logística', phases: 1, date_start: '2026-01-01', date_end: '2026-03-31' },
    { id: 30, name: '3T 2026 - Logística', phases: 1, auto_invoicing: true, date_start: '2026-06-30', date_end: '2026-12-31' },
    { id: 40, name: 'Altre', phases: 1, auto_invoicing: true },
  ];

  it('goes by the name, not by the dates', () => {
    // 3T runs till 31/12, but November is in the 4T: none yet
    expect(q.pickQuarterProject(projects, q.quarterOf('2026-11'))).toMatchObject({ project: null, latest: { id: 30 } });
    expect(q.pickQuarterProject(projects, q.quarterOf('2026-08')).project.id).toBe(30);
    expect(q.pickQuarterProject(projects, q.quarterOf('2026-02')).project.id).toBe(25);
  });

  it('of several, the one with the option, then the one with phases', () => {
    expect(q.pickQuarterProject(projects, q.quarterOf('2025-05'))).toMatchObject({ project: { id: 21 }, others: [{ id: 22 }] });
    const checked = projects.map((p) => (p.id === 22 ? { ...p, auto_invoicing: true } : p));
    expect(q.pickQuarterProject(checked, q.quarterOf('2025-05')).project.id).toBe(22);
  });

  it('leaves out the trash', () => {
    const trashed = projects.map((p) => (p.id === 30 ? { ...p, trashed: true } : p));
    expect(q.pickQuarterProject(trashed, q.quarterOf('2026-08'))).toMatchObject({ project: null, latest: { id: 25 } });
  });

  it("names the new one like the last one", () => {
    const q4 = q.quarterOf('2026-11');
    expect(q.newProjectName({ name: '3T 2026 - Logística' }, q4)).toBe('4T 2026 - Logística');
    expect(q.newProjectName({ name: 'Logística - 2025 - 2T' }, q4)).toBe('Logística - 2026 - 4T');
    expect(q.newProjectName({ name: 'Logística 2025 - 2T*' }, q4)).toBe('Logística 2026 - 4T');
    expect(q.newProjectName({ name: '2025 4T - Logística' }, q.quarterOf('2027-01'))).toBe('2027 1T - Logística');
    expect(q.newProjectName(null, q4)).toBe('4T 2026 - Logística');
  });
});

describe("creating the quarter's project (issues/430)", () => {
  function setup(rows) {
    jest.resetModules();
    const written = { projects: [], phases: [], transactions: 0 };
    const model = {
      id: 30,
      name: '3T 2026 - Logística',
      auto_invoicing: true,
      billing_mode: 'project',
      project_type: { id: 3 },
      project_scope: { id: 4 },
      project_state: { id: 2 },
      leader: { id: 7 },
      clients: [{ id: 11 }, { id: 12 }],
    };
    global.strapi = {
      log: { info: () => {} },
      db: {
        query: (uid) => ({
          findMany: async () => (uid === 'api::project-state.project-state' ? [{ id: 1, name: 'Actiu' }, { id: 2, name: 'Tancat' }] : rows),
          findOne: async ({ where }) => (where.id === model.id ? model : null),
        }),
        transaction: async (fn) => {
          written.transactions += 1;
          return fn();
        },
      },
      documents: () => ({
        create: async ({ data }) => {
          written.projects.push(data);
          return { id: 99, ...data };
        },
      }),
      controller: () => ({
        createPhaseWithNested: async (projectId, entity, phase) => written.phases.push({ projectId, entity, phase }),
      }),
    };
    return { q: require('../src/services/monthly-invoicing/quarter-project'), written };
  }
  afterEach(() => { delete global.strapi; });

  const rows = [
    { id: 25, name: '1T 2026 - Logística', project_phases: [{ id: 1 }] },
    { id: 30, name: '3T 2026 - Logística', auto_invoicing: true, project_phases: [{ id: 2 }] },
  ];

  it('dated the quarter, one phase «Logística», «Actiu», what the last one had', async () => {
    const { q: quarters, written } = setup(rows);
    const result = await quarters.createQuarterProject('2026-11');
    expect(result).toMatchObject({ project: { id: 99, name: '4T 2026 - Logística', auto_invoicing: true }, model: { id: 30 } });
    expect(written.projects).toEqual([{
      name: '4T 2026 - Logística',
      date_start: '2026-10-01',
      date_end: '2026-12-31',
      auto_invoicing: true,
      project_type: 3,
      project_scope: 4,
      leader: 7,
      clients: [11, 12],
      billing_mode: 'project',
      project_state: 1,
    }]);
    expect(written.phases).toEqual([
      { projectId: 99, entity: 'project-original-phases', phase: { name: 'Logística', position: 0, incomes: [], expenses: [] } },
      { projectId: 99, entity: 'project-phases', phase: { name: 'Logística', position: 0, incomes: [], expenses: [] } },
    ]);
    expect(written.transactions).toBe(1);
  });

  it('refused when the quarter has one', async () => {
    const { q: quarters, written } = setup(rows);
    await expect(quarters.createQuarterProject('2026-08')).rejects.toMatchObject({ status: 409, project: { id: 30 } });
    expect(written.projects).toEqual([]);
  });

  it('refused when the name is taken by a project in the trash', async () => {
    const { q: quarters, written } = setup([...rows, { id: 31, name: '4T 2026 - Logística', trashed: true, project_phases: [] }]);
    await expect(quarters.createQuarterProject('2026-11')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('a la paperera') });
    expect(written.projects).toEqual([]);
  });

  it('without any logistics project: «<n>T <any> - Logística», the option off', async () => {
    const { q: quarters, written } = setup([]);
    await quarters.createQuarterProject('2027-01');
    expect(written.projects[0]).toEqual({ name: '1T 2027 - Logística', date_start: '2027-01-01', date_end: '2027-03-31', auto_invoicing: false, billing_mode: 'project', project_state: 1 });
  });
});
