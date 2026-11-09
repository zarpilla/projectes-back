'use strict';

/**
 * issues/410 (2026-11-09, resilience): in «% Dedicació real» and «Previsió
 * dedicació», «Detall per» could group the hours by project, type or
 * likelihood but not by àmbit (Urtur, Balkar…), and the hours could not be
 * limited to some àmbits. Every breakdown row now carries the project's àmbit
 * and both Gantts take a scopeIds filter (0 = «Sense àmbit»).
 */

const ACTIVITY = 'api::activity.activity';
const URTUR = { id: 1, name: 'Urtur' };
const BALKAR = { id: 2, name: 'Balkar' };
const PERIODS = [{ from: '2026-01-01', to: '2026-12-31', hours: 8 }];
const USER = { id: 7, username: 'anna', hidden: false, daily_dedications: PERIODS, permissions: [{ permission: 'projects' }] };

function mockStrapi({ activities = [], projects = [] }) {
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () => {
          if (uid === ACTIVITY) return activities;
          if (uid === 'plugin::users-permissions.user') return [USER];
          if (uid === 'api::project.project') return projects;
          return [];
        },
      }),
    },
  };
}

describe('dedication Gantts by àmbit (issues/410)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-11-09T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete global.strapi;
  });

  describe('% Dedicació real', () => {
    const activities = [
      { date: '2026-03-02', hours: 5, users_permissions_user: { id: 7 }, project: { id: 10, name: 'A', project_scope: URTUR } },
      { date: '2026-03-03', hours: 3, users_permissions_user: { id: 7 }, project: { id: 11, name: 'B', project_scope: BALKAR } },
      { date: '2026-03-04', hours: 2, users_permissions_user: { id: 7 }, project: { id: 12, name: 'C', project_scope: null } },
      { date: '2026-04-01', hours: 4, users_permissions_user: { id: 7 }, project: null },
    ];

    it('gives the àmbit of each breakdown row', async () => {
      mockStrapi({ activities });
      const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
      const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
      expect(cells[7]['2026-03'].breakdown.map((r) => [r.project, r.scope, r.hours])).toEqual([
        ['A', 'Urtur', 5],
        ['B', 'Balkar', 3],
        ['C', '-', 2],
      ]);
    });

    it('counts only the hours of the chosen àmbits', async () => {
      mockStrapi({ activities });
      const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
      const { cells, periods } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month', scopeIds: [1] });
      expect(cells[7]['2026-03'].hours).toBe('5.00');
      expect(cells[7]['2026-03'].breakdown.map((r) => r.project)).toEqual(['A']);
      // the April hours without a project are not Urtur's
      expect(periods.map((p) => p.key || p)).not.toContainEqual('2026-04');
    });

    it('0 keeps the hours without an àmbit', async () => {
      mockStrapi({ activities });
      const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
      const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month', scopeIds: [2, 0] });
      expect(cells[7]['2026-03'].breakdown.map((r) => r.project)).toEqual(['B', 'C']);
      expect(cells[7]['2026-04'].hours).toBe('4.00');
    });
  });

  describe('Previsió dedicació', () => {
    const line = (hours) => ({
      incomes: [
        {
          quantity: 1,
          amount: 0,
          estimated_hours: [{ from: '2026-03-02', to: '2026-03-02', quantity: hours, quantity_type: 'total', users_permissions_user: { id: 7 } }],
        },
      ],
    });
    const projects = [
      { id: 10, name: 'A', trashed: false, project_scope: URTUR, project_phases: [line(6)] },
      { id: 11, name: 'B', trashed: false, project_scope: BALKAR, project_phases: [line(2)] },
    ];

    it('gives the àmbit of each breakdown row', async () => {
      mockStrapi({ projects });
      const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
      const { cells } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month' });
      expect(cells[7]['2026-03'].breakdown.map((r) => [r.project, r.scope])).toEqual([
        ['A', 'Urtur'],
        ['B', 'Balkar'],
      ]);
    });

    it('counts only the projects of the chosen àmbits', async () => {
      mockStrapi({ projects });
      const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
      const { cells } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month', scopeIds: [2] });
      expect(cells[7]['2026-03'].breakdown.map((r) => r.project)).toEqual(['B']);
      expect(Number(cells[7]['2026-03'].hours)).toBeCloseTo(2, 2);
    });
  });

  it('the controllers pass scopes=… on', async () => {
    jest.doMock('../src/api/project/services/realDedicationGantt', () => ({ buildRealDedicationGantt: jest.fn(async (a) => a) }));
    jest.doMock('../src/api/project/services/dedicationGantt', () => ({ buildDedicationGantt: jest.fn(async (a) => a) }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => (args) => build(args) } }));
    global.strapi = {};
    const actions = require('../src/api/project/controllers/project')({ strapi: global.strapi });
    const ctx = (q) => ({ query: { _where: { project_state_in: '1' }, ...q }, badRequest: jest.fn() });
    expect((await actions.findRealDedications(ctx({ scopes: '1,0' }))).scopeIds).toEqual([1, 0]);
    expect((await actions.findDedications(ctx({ scopes: '2' }))).scopeIds).toEqual([2]);
    expect((await actions.findRealDedications(ctx({}))).scopeIds).toEqual([]);
  });
});
