'use strict';

/**
 * issues/394 (security review round 2, 2026-10-31): each «Contacta» message
 * and each new incidence sends a mail to the office, with no limit. Users
 * without full access get a cap per hour (10 messages, 30 incidences).
 */
function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) =>
          uid === 'plugin::users-permissions.user'
            ? { id: where.id, permissions: permissions.map((p) => ({ permission: p })) }
            : { id: 9, owner: { id: 32 }, contact: { id: 7 }, status: 'pending' },
        ),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

const send = (middleware, handler, data) =>
  middleware(
    {
      method: 'POST',
      query: {},
      params: {},
      request: { body: { data } },
      state: { user: { id: 32 }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } } },
    },
    jest.fn(),
  );

describe('mail limits (issues/394)', () => {
  it('caps «Contacta» at 10 an hour for a member', async () => {
    const middleware = setup(['orders']);
    for (let i = 0; i < 10; i++) await send(middleware, 'api::form-submission.form-submission.create', { text: 'x' });
    await expect(send(middleware, 'api::form-submission.form-submission.create', { text: 'x' })).rejects.toMatchObject({
      name: 'RateLimitError',
    });
  });

  it('caps the new incidences sent with orders at 30 an hour', async () => {
    const middleware = setup(['orders']);
    const many = Array.from({ length: 31 }, () => ({ description: 'x' }));
    await expect(send(middleware, 'api::order.order.create', { incidences: many })).rejects.toMatchObject({ name: 'RateLimitError' });
  });

  it('leaves full-access users alone', async () => {
    const middleware = setup(['projects']);
    for (let i = 0; i < 12; i++) await send(middleware, 'api::form-submission.form-submission.create', { text: 'x' });
  });
});
