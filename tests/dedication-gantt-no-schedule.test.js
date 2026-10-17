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
    // a working-day period of 0 h (without any period the default is 8 h/day)
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
