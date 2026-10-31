'use strict';

/**
 * issues/375 (security review 2026-10-31): `_internal` is the flag the order
 * lifecycles set on their own writes to skip the price and discount
 * calculations. `POST /orders/csv` passed the request body to the service as
 * it came, so a member who added `"_internal": true` created an order with no
 * price (checked on a copy of La Diligència: 16.43 € without it, NULL with it).
 * `_tracking_user`, who the order's history names, was also taken as sent.
 *
 * Guards: the permissions middleware drops the server-only flags from every
 * request body, at any depth and for every user, and sets `_tracking_user` to
 * whoever makes the request.
 */

const ME = 100;

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) =>
          uid === 'plugin::users-permissions.user'
            ? { id: where.id, permissions: permissions.map((permission) => ({ permission })) }
            : null,
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

async function send(middleware, { handler, body, userId = ME }) {
  const [, rest] = handler.split('::');
  const ctx = {
    method: 'POST',
    query: {},
    params: {},
    request: { body },
    state: {
      user: userId ? { id: userId, username: 'me' } : undefined,
      route: { handler, info: { apiName: rest.split('.')[0] } },
    },
  };
  await middleware(ctx, jest.fn());
  return ctx.request.body;
}

describe('server-only flags in request bodies (issues/375)', () => {
  it("drops _internal from a member's CSV order and from its new contact", async () => {
    const middleware = setup(['orders']);
    const body = await send(middleware, {
      handler: 'api::order.order.createCSV',
      body: {
        route: { id: 25 },
        contact: { name: 'Nou punt', _internal: true },
        estimated_delivery_date: '2026-11-20',
        _internal: true,
        _previousOrderData: { status: 'delivered' },
        _incidencesToProcess: [{ description: 'x' }],
      },
    });
    expect(body._internal).toBeUndefined();
    expect(body._previousOrderData).toBeUndefined();
    expect(body._incidencesToProcess).toBeUndefined();
    expect(body.contact._internal).toBeUndefined();
    expect(body.contact.name).toBe('Nou punt');
  });

  it('drops it inside `data` and for full-access users too', async () => {
    const middleware = setup(['projects']);
    const body = await send(middleware, {
      handler: 'api::received-expense.received-expense.update',
      body: { data: { total: 10, _internal: true } },
    });
    expect(body.data).toEqual({ total: 10 });
  });

  it('records the change in the name of whoever makes it', async () => {
    const middleware = setup(['orders_admin']);
    const body = await send(middleware, {
      handler: 'api::order.order.update',
      body: { data: { status: 'delivered', _tracking_user: { id: 1, username: 'admin' } } },
    });
    expect(body.data._tracking_user).toEqual({ id: ME, username: 'me' });
  });
});
