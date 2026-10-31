'use strict';

/**
 * issues/394 (security review round 2, 2026-10-31): a member's new delivery
 * point kept the `contact_types` she sent, so tagging it «Sòcia» put it in the
 * energy community's partners list. Only «Punt d'entrega» stays.
 */
const ME = 32;
const TYPES = [
  { id: 1, name: 'Clienta' },
  { id: 3, name: 'Sòcia' },
  { id: 4, name: "Punt d'entrega" },
];

function setup() {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => ({ id: where.id, permissions: [{ permission: 'orders' }] })),
        findMany: jest.fn(async ({ where } = {}) =>
          uid === 'api::contact-type.contact-type' ? TYPES.filter((t) => where.id.$in.includes(t.id)) : [],
        ),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function create(types) {
  const middleware = setup();
  const ctx = {
    method: 'POST',
    query: {},
    params: {},
    request: { body: { data: { name: 'Botiga', contact_types: types } } },
    state: { user: { id: ME }, route: { handler: 'api::contact.contact.create', info: { apiName: 'contact' } } },
  };
  await middleware(ctx, jest.fn());
  return ctx.request.body.data;
}

describe("a member's new point types (issues/394)", () => {
  it("keeps only «Punt d'entrega»", async () => {
    expect((await create([3, 4, 1])).contact_types).toEqual([4]);
    expect((await create([{ id: 4 }])).contact_types).toEqual([4]);
  });

  it('drops the types when none is a delivery point', async () => {
    expect((await create([3])).contact_types).toBeUndefined();
  });
});
