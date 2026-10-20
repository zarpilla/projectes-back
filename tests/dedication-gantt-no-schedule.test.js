'use strict';

/**
 * issues/077 (2026-10-16): «Previsió dedicació» and «% Dedicació real» showed
 * 0 % for a person with hours (e.g. 34,66 h) but a 0 h working day for the
 * period. The front guessed «no working day» from a 0 percentage, which
 * also mislabelled a real but tiny percentage. Each cell now says it.
 */

const ACTIVITY = 'api::activity.activity';

function mockStrapi() {
  const users = [
    // a working-day period of 0 h
    { id: 1, username: 'sense-jornada', hidden: false, daily_dedications: [{ from: '2026-01-01', to: '2026-12-31', hours: 0 }] },
    { id: 2, username: 'amb-jornada', hidden: false, daily_dedications: [{ from: '2026-01-01', to: '2026-12-31', hours: 8 }], permissions: [{ permission: 'projects' }] },
    { id: 3, username: 'Sòcia SCCL', hidden: false, daily_dedications: [], permissions: [{ permission: 'orders' }] },
  ];
  const activities = [
    { date: '2026-03-02', hours: 34.66, users_permissions_user: { id: 1 }, project: { id: 9, name: 'P' } },
    { date: '2026-03-02', hours: 0.3, users_permissions_user: { id: 2 }, project: { id: 9, name: 'P' } },
  ];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () =>
          uid === ACTIVITY ? activities : uid === 'plugin::users-permissions.user' ? users : [],
      }),
    },
  };
}

describe('dedication gantt cells without a working day (issues/077)', () => {
  beforeEach(() => { jest.resetModules(); mockStrapi(); });
  afterEach(() => { delete global.strapi; });

  it('% Dedicació real flags the cell instead of a 0 % comparison', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    const key = Object.keys(cells[1])[0];
    expect(cells[1][key]).toMatchObject({ hours: '34.66', noSchedule: true });
    expect(cells[2][key]).toMatchObject({ hours: '0.30', percentage: '0', noSchedule: false });
  });

  // issues/109: logistics members (orders only) were listed as «persones sense hores»
  it('says which people can log hours', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { leaders } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    expect(leaders.map((l) => [l.username, l.works])).toEqual([
      ['sense-jornada', false], ['amb-jornada', true], ['Sòcia SCCL', false],
    ]);
  });
});

/**
 * issues/272 (2026-10-20, review 8): people without any period were counted at
 * 8 h a weekday in % Dedicació real and Previsió dedicació (Rosa Sep 2021
 * «187,8 ↑ 107 %», prova.hores Oct 2026 «0,0 ↓ 0 %»), while Saldo d'hores
 * says «sense jornada». No period: 0 theoretical hours, «s/j».
 */
describe('dedication gantt cells for people without a period (issues/272)', () => {
  const users = [
    { id: 4, username: 'sense-periode', hidden: false, daily_dedications: [], permissions: [{ permission: 'projects' }] },
    // a period that starts in April: March has no jornada
    { id: 5, username: 'des-d-abril', hidden: false, daily_dedications: [{ from: '2026-04-01', to: '2026-12-31', hours: 8 }], permissions: [{ permission: 'projects' }] },
  ];
  const activities = [
    { date: '2026-03-02', hours: 20, users_permissions_user: { id: 4 }, project: { id: 9, name: 'P' } },
    { date: '2026-03-03', hours: 0.02, users_permissions_user: { id: 5 }, project: { id: 9, name: 'P' } },
  ];
  beforeEach(() => {
    jest.resetModules();
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async () =>
            uid === ACTIVITY ? activities : uid === 'plugin::users-permissions.user' ? users : [],
        }),
      },
    };
  });
  afterEach(() => { delete global.strapi; });

  it('capacity is 0 h without a period', () => {
    const { capacityForMonth, capacityForWeek } = require('../src/api/project/services/ganttCapacity');
    expect(capacityForMonth('2026-03', [], new Set())).toEqual({ expected: 0, festive: 0 });
    expect(capacityForWeek('2026-W10', null, new Set())).toEqual({ expected: 0, festive: 0 });
  });

  it('% Dedicació real shows s/j', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    const key = Object.keys(cells[4]).find((k) => k.endsWith('03')) || Object.keys(cells[4])[0];
    expect(cells[4][key]).toMatchObject({ hours: '20.00', expected: 0, noSchedule: true });
    expect(cells[5][key]).toMatchObject({ expected: 0, noSchedule: true });
  });
});
