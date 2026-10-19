'use strict';

/**
 * issues/188 (2026-10-19): users without full access still populated their way
 * from an allowed catalog (or from incidences) into data their role can't read:
 * - `/routes?populate[project][populate][activities][populate][users_permissions_user]`
 *   gave a member, a driver or a worker 5.624 activities of 9 workers (date,
 *   hours, description); same through `/tasks` and `/activity-types`;
 * - `/routes?populate[project][populate][project_phases][populate][incomes]`
 *   the income lines, whose concepts name other members;
 * - `/festives?populate[users_permissions_user]` everyone's personal holidays;
 * - a driver's `/incidences?populate[order][populate][emitted_invoice]` the
 *   whole invoice, while `/emitted-invoices` is 403 for her;
 * - `hours`-only users read routes, tariffs, pickups, products, city routes.
 */

const ME = 100;
const USER = 'plugin::users-permissions.user';

const contentTypes = {
  'api::route.route': { attributes: { project: { type: 'relation', target: 'api::project.project' } } },
  'api::task.task': { attributes: { project: { type: 'relation', target: 'api::project.project' } } },
  'api::project.project': {
    attributes: {
      activities: { type: 'relation', target: 'api::activity.activity' },
      project_phases: { type: 'relation', target: 'api::project-phase.project-phase' },
      mother: { type: 'relation', target: 'api::project.project' },
    },
  },
  'api::activity.activity': {
    attributes: {
      users_permissions_user: { type: 'relation', target: USER },
      project: { type: 'relation', target: 'api::project.project' },
    },
  },
  'api::project-phase.project-phase': { attributes: {} },
  'api::incidence.incidence': { attributes: { order: { type: 'relation', target: 'api::order.order' } } },
  'api::order.order': {
    attributes: { emitted_invoice: { type: 'relation', target: 'api::emitted-invoice.emitted-invoice' } },
  },
  'api::emitted-invoice.emitted-invoice': { attributes: {} },
  [USER]: { attributes: {} },
};

function makeStrapi(permissions, rows = {}) {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === USER) return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
      return (rows[uid] || {})[where.id] || null;
    }),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  });
  return { db: { query: jest.fn(query) }, contentTypes, components: {} };
}

async function call(permissions, handler, { answer, query = {}, numericId, rows } = {}) {
  jest.resetModules();
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi: makeStrapi(permissions, rows) });
  const ctx = {
    method: 'GET',
    query,
    params: {},
    request: {},
    state: {
      user: { id: ME },
      route: { handler, info: {} },
      v3: numericId !== undefined ? { numericId } : undefined,
    },
  };
  const next = jest.fn(async () => {
    if (answer !== undefined) ctx.body = answer;
  });
  await middleware(ctx, next);
  return ctx;
}

const project = () => ({
  id: 2,
  name: 'Diligència',
  total_real_hours: 30,
  activities: [{ id: 9, hours: 4, description: 'reunió', users_permissions_user: { id: 3, username: 'anna' } }],
  project_phases: [{ id: 5, incomes: [{ concept: 'Comanda #12# - Sòcia X' }] }],
});

describe('populates into what the role cannot read (issues/188)', () => {
  it.each([['orders'], ['orders_delivery'], ['orders_admin']])(
    "%s gets a route's project without its hours and budget lines",
    async (permission) => {
      const ctx = await call([permission], 'api::route.route.find', { answer: [{ id: 14, project: project() }] });
      expect(ctx.body[0].project).toEqual({ id: 2, name: 'Diligència', total_real_hours: 30 });
    },
  );

  it("a worker gets a task's project without everyone's hours", async () => {
    const ctx = await call(['hours'], 'api::task.task.find', {
      answer: { data: [{ id: 1, project: { ...project(), mother: project() } }], meta: {} },
    });
    expect(ctx.body.data[0].project.activities).toBeUndefined();
    expect(ctx.body.data[0].project.mother.activities).toBeUndefined();
  });

  it('keeps the activities of the project read itself (Informes › Dedicació, phases-both)', async () => {
    const ctx = await call(['hours'], 'api::project.project.findWithPhasesBoth', { answer: [project()] });
    expect(ctx.body[0].activities).toHaveLength(1);
    expect(ctx.body[0].project_phases).toHaveLength(1);
  });

  it("a driver gets an incidence's order without its invoice; the office keeps it", async () => {
    const answer = () => [{ id: 1, order: { id: 24905, emitted_invoice: { id: 7, total: 13.99 } } }];
    const driver = await call(['orders_delivery'], 'api::incidence.incidence.find', { answer: answer() });
    expect(driver.body[0].order).toEqual({ id: 24905 });
    const office = await call(['orders_admin'], 'api::incidence.incidence.find', { answer: answer() });
    expect(office.body[0].order.emitted_invoice).toEqual({ id: 7, total: 13.99 });
  });

  it('a worker reads only the holidays for everyone and her own', async () => {
    const ctx = await call(['hours'], 'api::festive.festive.find', { query: { _limit: -1 } });
    expect(ctx.query._where._and[0]).toEqual({
      _or: [{ 'users_permissions_user.id_null': true }, { 'users_permissions_user.id': ME }],
    });
    const rows = {
      'api::festive.festive': {
        1: { id: 1, users_permissions_user: { id: 3 } },
        2: { id: 2, users_permissions_user: null },
        3: { id: 3, users_permissions_user: { id: ME } },
      },
    };
    await expect(call(['hours'], 'api::festive.festive.findOne', { numericId: 1, rows })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    await call(['hours'], 'api::festive.festive.findOne', { numericId: 2, rows });
    await call(['hours'], 'api::festive.festive.findOne', { numericId: 3, rows });
  });

  it.each([
    'api::route.route.find',
    'api::route-rate.route-rate.find',
    'api::pickup.pickup.find',
    'api::product.product.find',
    'api::city-route.city-route.find',
    'api::city-route.city-route.basic',
  ])('a worker does not read the logistics catalog %s', async (handler) => {
    await expect(call(['hours'], handler)).rejects.toMatchObject({ name: 'ForbiddenError' });
    await call(['orders'], handler);
  });
});
