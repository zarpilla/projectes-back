'use strict';

/**
 * "Hores originals" / "Hores previstes" came out at 0 € for everybody: the
 * estimated hours were counted but never multiplied by the person's cost/hour.
 *
 * calculateEstimatedTotals looks up each person's calendar (daily-dedication)
 * by `users_permissions_user.id`, and treats a festive without that relation as
 * a holiday for everyone. v3's findMany() populated first-level relations; v5's
 * strapi.db.query().findMany() does not, so every calendar was dropped (cost/hour
 * 0) and every personal festive became a company-wide one. Each loader feeding
 * the engine must populate users_permissions_user.
 */

const fs = require('fs');
const path = require('path');

const { calculateEstimatedTotals } = require('../src/api/project/services/projectFinancials');

const USER = { id: 7 };
const DEDICATIONS = [{ id: 1, from: '2026-01-01', to: '2026-12-31', costByHour: 20, users_permissions_user: USER }];
const FESTIVES = [{ id: 1, date: '2026-03-03', users_permissions_user: USER }];

// Mimics v5's query engine: relations come back only when populated.
const fakeQuery = (rows) => ({
  findMany: async (args = {}) =>
    rows.map(({ users_permissions_user, ...rest }) =>
      args.populate && args.populate.users_permissions_user ? { ...rest, users_permissions_user } : rest,
    ),
});

const phases = () => [
  {
    incomes: [
      {
        quantity: 1,
        amount: 1000,
        estimated_hours: [
          // 10 h/week, Mon 2026-03-02 → Mon 2026-03-09: 5 working days at 2 h
          { from: '2026-03-02', to: '2026-03-09', quantity: 10, quantity_type: 'week', users_permissions_user: USER },
        ],
      },
    ],
  },
];

describe('estimated hours cost (calendars populated with their user)', () => {
  let cache;

  beforeEach(() => {
    jest.resetModules();
    global.strapi = {
      db: {
        query: (uid) => fakeQuery(uid === 'api::festive.festive' ? FESTIVES : DEDICATIONS),
      },
    };
    // the calendars the engine reads (services/calendars.js, issues/307)
    cache = require('../src/services/calendars');
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('multiplies the estimated hours by the calendar cost/hour', async () => {
    const out = await calculateEstimatedTotals(
      { id: 1, name: 'p' },
      phases(),
      await cache.getDailyDedications(),
      [],
    );
    expect(out.total_estimated_hours).toBeCloseTo(10);
    expect(out.total_estimated_hours_price).toBeCloseTo(200);
  });

  it("keeps a personal festive personal — only that user's day is dropped", async () => {
    const festives = await cache.getFestives();
    expect(festives[0].users_permissions_user).toEqual(USER);

    const other = phases();
    other[0].incomes[0].estimated_hours[0].users_permissions_user = { id: 8 };
    const out = await calculateEstimatedTotals({ id: 1, name: 'p' }, other, [], festives);
    expect(out.total_estimated_hours).toBeCloseTo(10);
  });
});

describe('the project controller takes the calendars from services/calendars.js', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'project', 'controllers', 'project.js'),
    'utf8',
  );

  // a loader of its own would bypass the populate checked above, and the
  // read cache's shared copy (issues/307)
  it.each(['api::daily-dedication.daily-dedication', 'api::festive.festive'])('%s', (uid) => {
    const loads = controller
      .split(`.query('${uid}')`)
      .slice(1)
      .filter((rest) => /^\s*\.findMany\(/.test(rest));
    expect(loads).toEqual([]);
  });
});
