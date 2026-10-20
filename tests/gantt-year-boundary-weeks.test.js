'use strict';

/**
 * issues/265 (2026-10-20, review 8): in the weekly view of % Dedicació real and
 * Previsió dedicació the ISO weeks crossing the year end mixed years: 2025
 * showed two «W1» columns (2025-W01 and 2026-W01), and a partial week was
 * compared with a full week of jornada, the days of the other year included
 * (whose hours and holidays aren't loaded). Joel's last week of 2025
 * (29/12–31/12 all vacation) showed «7,0 h ↓ 44 %» (7 h vs 16 h of 1–2 Jan
 * 2026) instead of s/j. The weeks now count only the days of the chosen year
 * and are labelled with their ISO year («W1 2026»).
 */

const { capacityForWeek, weekLabel } = require('../src/api/project/services/ganttCapacity');

const PERIOD = { from: '2024-01-01', to: '2026-12-31', hours: 8 };
const JOEL = { id: 15, username: 'joel' };

function mockStrapi({ activities = [], festives = [], projects = [] }) {
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () => {
          if (uid === 'api::activity.activity') return activities;
          if (uid === 'api::festive.festive') return festives;
          if (uid === 'api::project.project') return projects;
          if (uid === 'plugin::users-permissions.user') {
            return [{ ...JOEL, hidden: false, daily_dedications: [PERIOD], permissions: [{ permission: 'projects' }] }];
          }
          return [];
        },
      }),
    },
  };
}

describe('weeks crossing the year end (issues/265)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('a week counts only the days of the chosen year', () => {
    // Mon 29/12/2025 – Sun 04/01/2026
    expect(capacityForWeek('2026-W01', [PERIOD], new Set(), 2025)).toEqual({ expected: 24, festive: 0 });
    expect(capacityForWeek('2026-W01', [PERIOD], new Set(['2026-01-01']), 2026)).toEqual({ expected: 8, festive: 8 });
    // Mon 30/12/2024 – Sun 05/01/2025
    expect(capacityForWeek('2025-W01', [PERIOD], new Set(['2025-01-01']), 2025)).toEqual({ expected: 16, festive: 8 });
    // without a year, the whole week as before
    expect(capacityForWeek('2026-W01', [PERIOD], new Set())).toEqual({ expected: 40, festive: 0 });
  });

  it('labels the weeks with their ISO year', () => {
    expect(weekLabel('2025-W01')).toBe('W1 2025');
    expect(weekLabel('2026-W01')).toBe('W1 2026');
    expect(weekLabel('2026-W53')).toBe('W53 2026');
  });

  it('% Dedicació real: distinct labels and the last week of 2025 without jornada is s/j', async () => {
    mockStrapi({
      activities: [
        { date: '2025-01-02', hours: 8, users_permissions_user: JOEL, project: { id: 9, name: 'P' } },
        { date: '2025-12-29', hours: 7, users_permissions_user: JOEL, project: { id: 9, name: 'P' } },
      ],
      festives: [
        { date: '2025-01-01', users_permissions_user: null },
        { date: '2025-12-29', users_permissions_user: JOEL },
        { date: '2025-12-30', users_permissions_user: JOEL },
        { date: '2025-12-31', users_permissions_user: JOEL },
      ],
    });
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { periods, cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2025, view: 'week' });
    expect(periods.map((p) => p.label)).toEqual(['W1 2025', 'W1 2026']);
    // 2–3 Jan 2025, not 30–31 Dec 2024
    expect(cells[JOEL.id]['2025-W01']).toMatchObject({ hours: '8.00', expected: 16, percentage: '50' });
    expect(cells[JOEL.id]['2026-W01']).toMatchObject({ hours: '7.00', expected: 0, noSchedule: true });
  });

  it('Previsió dedicació: the first and last columns of 2025 are W1 2025 and W1 2026', async () => {
    mockStrapi({});
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { periods } = await buildDedicationGantt({ projectStateIds: [1], year: 2025, view: 'week' });
    expect(periods[0].label).toBe('W1 2025');
    expect(periods[periods.length - 1]).toMatchObject({ key: '2026-W01', label: 'W1 2026' });
    expect(new Set(periods.map((p) => p.label)).size).toBe(periods.length);
  });
});
