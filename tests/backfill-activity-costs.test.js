'use strict';

/**
 * issues/012 — startup script that brings "Hores executades" up to date:
 * prices activities left without cost/hour from the covering daily dedication
 * and marks every project with activities dirty so the totals cron recomputes it.
 */

const DEDICATION = 'api::daily-dedication.daily-dedication';

let updates;

function mockStrapi({ dedications, activities, links }) {
  updates = [];
  const table = (name) => {
    const q = {
      whereIn: jest.fn((col, ids) => ({
        update: jest.fn(async (data) => updates.push({ table: name, ids, data })),
      })),
      distinct: jest.fn(async (col) => links.map((l) => ({ [col]: l.project_id }))),
    };
    return q;
  };
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async () => (uid === DEDICATION ? dedications : activities)),
      })),
      metadata: {
        get: jest.fn(() => ({
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
        })),
      },
      connection: jest.fn(table),
    },
  };
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  delete global.strapi;
});

describe('backfillActivityCosts', () => {
  it('prices activities from the covering dedication and marks their projects dirty', async () => {
    mockStrapi({
      dedications: [
        { id: 1, from: '2024-01-01', to: '2024-12-31', costByHour: '14.50', users_permissions_user: { id: 16 } },
        { id: 2, from: '2025-01-01', to: '2025-12-31', costByHour: 0, users_permissions_user: { id: 9 } },
      ],
      activities: [
        { id: 100, date: '2024-06-28', users_permissions_user: { id: 16 } },
        { id: 101, date: '2024-06-21', users_permissions_user: { id: 16 } },
        // dedication with no cost: left alone
        { id: 102, date: '2025-05-15', users_permissions_user: { id: 9 } },
        // no dedication covers the date: left alone
        { id: 103, date: '2023-02-01', users_permissions_user: { id: 16 } },
      ],
      links: [{ project_id: 25 }, { project_id: 2 }],
    });
    const { backfillActivityCosts } = require('../src/services/backfill-activity-costs');

    await backfillActivityCosts();

    expect(updates).toEqual([
      { table: 'activities', ids: [100, 101], data: { cost_by_hour: 14.5 } },
      { table: 'projects', ids: [25, 2], data: { dirty: true } },
    ]);
  });
});
