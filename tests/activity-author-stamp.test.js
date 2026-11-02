'use strict';

/**
 * Dedications (activities) carried no author: they are written by the app's
 * logged-in users, for whom Strapi leaves created_by_id NULL (that column only
 * names admin-panel users), and the change-log tracks invoices and orders but
 * not activities. After a batch of backdated entries nobody could tell from
 * the database who had entered or last changed a record.
 *
 * The lifecycles now stamp the requesting user (id + username, the same source
 * as the change-log's currentUser) on every activity write: created_by_* on
 * create, updated_by_* on create and update. A write without a request user
 * behind it (a cron, a worker) stamps nothing.
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleRefresh: jest.fn(),
}));

const lifecycles = require('../src/api/activity/content-types/activity/lifecycles');

function mockStrapi(user) {
  global.strapi = {
    requestContext: { get: () => (user ? { state: { user } } : undefined) },
    db: {
      query: jest.fn(() => ({
        findMany: jest.fn(async () => []),
        findOne: jest.fn(async () => null),
      })),
    },
  };
}

afterEach(() => {
  delete global.strapi;
});

const JORDI = { id: 15, username: 'Jordi', email: 'jordi@webcoop.cat' };

describe('activity author stamp', () => {
  it('stamps created_by and updated_by on create', async () => {
    mockStrapi(JORDI);
    const data = { hours: 2, date: '2026-11-02', users_permissions_user: { set: [{ id: 15 }] } };
    await lifecycles.beforeCreate({ params: { data } });
    expect(data.created_by_user_id).toBe(15);
    expect(data.created_by_username).toBe('Jordi');
    expect(data.updated_by_user_id).toBe(15);
    expect(data.updated_by_username).toBe('Jordi');
  });

  it('stamps only updated_by on update, leaving the original author', async () => {
    mockStrapi({ id: 3, username: 'Òscar' });
    const data = { hours: 3, created_by_user_id: 15, created_by_username: 'Jordi' };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data.updated_by_user_id).toBe(3);
    expect(data.updated_by_username).toBe('Òscar');
    expect(data.created_by_user_id).toBe(15);
    expect(data.created_by_username).toBe('Jordi');
  });

  it('stamps nothing when no user is behind the write (cron, worker)', async () => {
    mockStrapi(null);
    const data = { hours: 2 };
    await lifecycles.beforeCreate({ params: { data } });
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect('created_by_user_id' in data).toBe(false);
    expect('updated_by_username' in data).toBe(false);
  });

  it('cannot be forged by values already in the payload', async () => {
    mockStrapi(JORDI);
    const data = { updated_by_user_id: 1, updated_by_username: 'Laura' };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data.updated_by_user_id).toBe(15);
    expect(data.updated_by_username).toBe('Jordi');
  });

  it('falls back to the email when the user has no username', async () => {
    mockStrapi({ id: 7, email: 'an@resilience.earth' });
    const data = {};
    await lifecycles.beforeCreate({ params: { data } });
    expect(data.created_by_username).toBe('an@resilience.earth');
  });
});
