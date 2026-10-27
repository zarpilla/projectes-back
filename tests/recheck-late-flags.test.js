'use strict';

/**
 * issues/346 (La Diligència, 2026-10-26): pickups on the «(TARDA)» routes
 * entered the day before after 13 h were marked late (the afternoon was told
 * by a time slot no route had), and orders re-saved by members were judged a
 * day early (the form's dates read in UTC). The startup script marks the
 * «TARDA» routes as afternoon ones and clears the marks that were wrong on the
 * open orders; these are the rows of that Monday, as stored in production.
 */
const { afternoonRouteIds, marksToClear } = require('../src/services/recheck-late-flags');
const { lateRules } = require('../src/services/late-order');

describe('recheckLateFlags (issues/346)', () => {
  it('marks the routes named «TARDA» as afternoon ones, once', () => {
    const routes = [
      { id: 25, name: 'DT - (TARDA) EMPORDÀ', afternoon: null },
      { id: 26, name: 'DC - (TARDA) BAIX MONTSENY + VALLÈS', afternoon: true },
      { id: 11, name: 'DT - BAIX MONTSENY', afternoon: null },
      { id: 30, name: 'Tardana', afternoon: false },
    ];
    expect(afternoonRouteIds(routes)).toEqual([25]);
  });

  it("clears the wrong marks of 2026-10-26 and keeps the right ones", () => {
    const rules = lateRules({ next_day_limit_hour: 13, late_surcharge: 0 }, 'Europe/Andorra');
    const at = (hhmm) => new Date(`2026-10-26T${hhmm}:00+01:00`);
    // knex reads DATE columns as UTC midnights
    const day = (d) => new Date(`${d}T00:00:00.000Z`);
    const TARDA = 25;
    const MORNING = 11;
    const rows = [
      { id: 25761, created_at: at('14:12'), estimated_delivery_date: day('2026-10-27'), late_order: 1, late_pickup: 0 },
      { id: 25762, created_at: at('15:00'), estimated_delivery_date: day('2026-10-27'), late_order: 1, late_pickup: 0 },
      { id: 25763, created_at: at('16:13'), estimated_delivery_date: day('2026-10-28'), collection_pickup_date: day('2026-10-27'), pickup_route: TARDA, late_order: 0, late_pickup: 1 },
      { id: 25766, created_at: at('16:27'), estimated_delivery_date: day('2026-10-28'), collection_pickup_date: day('2026-10-27'), pickup_route: TARDA, late_order: 1, late_pickup: 1 },
      { id: 25767, created_at: at('16:48'), estimated_delivery_date: day('2026-10-28'), collection_pickup_date: day('2026-10-27'), pickup_route: TARDA, late_order: 0, late_pickup: 1 },
      { id: 25768, created_at: at('17:01'), estimated_delivery_date: day('2026-10-28'), collection_pickup_date: day('2026-10-27'), pickup_route: TARDA, late_order: 1, late_pickup: 1 },
      { id: 25769, created_at: at('17:21'), estimated_delivery_date: day('2026-10-28'), collection_pickup_date: day('2026-10-27'), pickup_route: MORNING, late_order: 0, late_pickup: 1 },
    ];
    expect(marksToClear(rows, rules, new Set([TARDA]))).toEqual({
      orderIds: [25766, 25768],
      pickupIds: [25763, 25766, 25767, 25768],
    });
  });
});
