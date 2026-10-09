'use strict';

/**
 * Regression: issues/025 — admin-only operations answered 500 to non-admins.
 *
 * src/policies/isAdmin.js called ctx.forbidden()/ctx.unauthorized(), which a
 * Strapi 5 policy context doesn't have ("ctx.forbidden is not a function").
 * The request was still refused, but as a 500. Strapi 5 policies throw a
 * PolicyError (403) or return a falsy value instead.
 * Found by the front's e2e tests on 2026-10-09.
 */

const path = require('path');

const POLICY = path.join(__dirname, '..', 'src', 'policies', 'isAdmin.js');

function stubStrapi(usersById) {
  global.strapi = {
    db: { query: jest.fn(() => ({ findOne: jest.fn(async ({ where }) => usersById[where.id] || null) })) },
  };
  return global.strapi;
}

const policyContext = (user) => ({ state: { user } });

describe('isAdmin policy (issues/025)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      1: { id: 1, permissions: [{ permission: 'admin' }] },
      2: { id: 2, permissions: [{ permission: 'hours' }] },
    });
  });
  afterEach(() => { delete global.strapi; });

  it('lets admins through', async () => {
    await expect(require(POLICY)(policyContext({ id: 1 }), {}, { strapi: global.strapi })).resolves.toBe(true);
  });

  it('refuses other users with a 403 PolicyError', async () => {
    await expect(require(POLICY)(policyContext({ id: 2 }), {}, { strapi: global.strapi }))
      .rejects.toMatchObject({ name: 'PolicyError' }); // answered as 403
  });

  it('refuses anonymous requests with a 401', async () => {
    await expect(require(POLICY)(policyContext(undefined), {}, { strapi: global.strapi }))
      .rejects.toMatchObject({ name: 'UnauthorizedError' }); // answered as 401
  });
});
