'use strict';

/**
 * issues/389 (security review round 2, 2026-10-31), on a copy of La
 * Diligència, a worker with only `hours`:
 * - stored `cost_by_hour: 999` on her own activity (it feeds the projects' real cost);
 * - set `users_permissions_user: null` on her own holiday, which made it a
 *   holiday for every worker;
 * - linked her workday log to an admin's activity and then read it (hours,
 *   project, person) with her logs.
 */
const ME = 66;
const OTHER = 20;

function setup({ activities = {}, rows = {} } = {}) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') return { id: where.id, permissions: [{ permission: 'hours' }] };
          if (uid === 'api::activity.activity' && activities[where.id]) return activities[where.id];
          return rows[where.id] || null;
        }),
        findMany: jest.fn(async () => []),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function call(middleware, handler, { method, body, id }) {
  const ctx = {
    method,
    query: {},
    params: id ? { id: String(id) } : {},
    request: { body },
    state: { user: { id: ME }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } } },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return { ctx, next };
}

const own = { id: 1, users_permissions_user: { id: ME } };

describe('worker writes (issues/389)', () => {
  it('drops the cost, price and invoiced flag of her activities', async () => {
    const middleware = setup({ rows: { 1: own } });
    const created = await call(middleware, 'api::activity.activity.create', {
      method: 'POST',
      body: { data: { hours: 1, cost_by_hour: 999, invoice_hours_price: 80, invoiced: true } },
    });
    expect(created.ctx.request.body.data).toEqual({ hours: 1, users_permissions_user: ME });
    const updated = await call(middleware, 'api::activity.activity.update', {
      method: 'PUT',
      id: 1,
      body: { data: { hours: 2, cost_by_hour: 999 } },
    });
    expect(updated.ctx.request.body.data).toEqual({ hours: 2 });
  });

  it.each(['api::festive.festive.update', 'api::activity.activity.update', 'api::workday-log.workday-log.update'])(
    '%s refuses taking the row away from her (user null)',
    async (handler) => {
      const middleware = setup({ rows: { 1: own } });
      await expect(
        call(middleware, handler, { method: 'PUT', id: 1, body: { data: { users_permissions_user: null } } }),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });
    },
  );

  it('links her workday log only to her own activities (or none)', async () => {
    const activities = { 5: { id: 5, users_permissions_user: { id: ME } }, 3201: { id: 3201, users_permissions_user: { id: OTHER } } };
    const middleware = setup({ activities, rows: { 1: own } });
    const ok = await call(middleware, 'api::workday-log.workday-log.update', { method: 'PUT', id: 1, body: { data: { activity: 5 } } });
    expect(ok.next).toHaveBeenCalled();
    const none = await call(middleware, 'api::workday-log.workday-log.create', { method: 'POST', body: { data: { activity: null } } });
    expect(none.next).toHaveBeenCalled();
    await expect(
      call(middleware, 'api::workday-log.workday-log.update', { method: 'PUT', id: 1, body: { data: { activity: 3201 } } }),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(
      call(middleware, 'api::workday-log.workday-log.create', { method: 'POST', body: { data: { activity: { connect: [3201] } } } }),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
});
