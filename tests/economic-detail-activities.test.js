'use strict';

/**
 * issues/060 (2026-10-16): «Hores exec» in Informes › Ingressos/Despeses was
 * always 0 €. findWithEconomicDetail populates the activities under each
 * project, so they have no `project` field, and the grouping filtered on it:
 * every activity was dropped.
 *
 * issues/205: undated activities were dropped too, so the report had fewer
 * hours than the project form. They go to the undated (9999) bucket, like
 * undated lines.
 */

const { activitiesByProjectMonth } = require('../src/api/project/services/economic-detail-activities');

describe('executed hours of the economic detail (issues/060)', () => {
  it('groups each project\'s populated activities by month', () => {
    const map = activitiesByProjectMonth([
      {
        id: 7,
        activities: [
          { date: '2025-03-02', hours: 2, cost_by_hour: 30 },
          { date: '2025-03-20', hours: 1, cost_by_hour: 40 },
          { date: '2025-04-01', hours: 3, cost_by_hour: 30 },
          { date: null, hours: 5, cost_by_hour: 30 },
        ],
      },
      { id: 8, activities: [] },
      { id: 9 },
    ]);
    expect([...map.keys()]).toEqual([7]);
    expect(map.get(7)).toEqual([
      { projectId: 7, year: 2025, month: 3, hours: 3, cost: 100 },
      { projectId: 7, year: 2025, month: 4, hours: 3, cost: 90 },
      { projectId: 7, year: 9999, month: 12, hours: 5, cost: 150 },
    ]);
  });

  it('puts a project\'s undated activities in the undated bucket (issues/205)', () => {
    const map = activitiesByProjectMonth([
      { id: 25, activities: [{ date: null, hours: 6.5, cost_by_hour: 20 }, { date: '2024-11-05', hours: 6 }] },
    ]);
    expect(map.get(25)).toEqual([
      { projectId: 25, year: 9999, month: 12, hours: 6.5, cost: 130 },
      { projectId: 25, year: 2024, month: 11, hours: 6, cost: 0 },
    ]);
  });
});
