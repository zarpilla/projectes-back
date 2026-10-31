'use strict';

/**
 * issues/391 (security review round 2, 2026-10-31): members see only the names
 * of the other users, but `/api/users?_where[email_contains]=webcoop` (1 row vs
 * 0) and `/api/contacts?_where[owner.email_contains]=…` read their e-mails
 * character by character, `_where[permissions.permission]=admin` told who is
 * admin. And `_q` on `/api/projects/basic` searched every column: a worker
 * found project 809 by a word only in its internal notes.
 *
 * Guards: a member filters and sorts users (directly or through relations) only
 * by what she sees of them; for users without full access `_q` on projects and
 * contacts searches only visible fields.
 */
const { filterPaths } = require('../src/services/query-guard');
const ME = 32;
const USER = 'plugin::users-permissions.user';

const contentTypes = {
  [USER]: {
    attributes: {
      username: { type: 'string' },
      email: { type: 'email' },
      permissions: { type: 'component', component: 'permissions.application-permission' },
    },
  },
  'api::contact.contact': {
    attributes: {
      name: { type: 'string' },
      owner: { type: 'relation', relation: 'manyToOne', target: USER },
    },
  },
  'api::project.project': { attributes: { name: { type: 'string' } } },
};

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => ({ id: where.id, permissions: permissions.map((p) => ({ permission: p })) })),
        findMany: jest.fn(async () => (uid === 'api::contact.contact' ? [{ id: 7 }] : [])),
      })),
    },
    contentTypes,
    components: { 'permissions.application-permission': { attributes: { permission: { type: 'string' } } } },
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function get(middleware, handler, query) {
  const info = handler.startsWith('plugin::') ? { pluginName: 'users-permissions' } : { apiName: handler.split('::')[1].split('.')[0] };
  const ctx = { method: 'GET', query, params: {}, request: {}, state: { user: { id: ME }, route: { handler, info } } };
  const next = jest.fn();
  await middleware(ctx, next);
  return { ctx, next };
}

describe('filterPaths', () => {
  it('lists the field paths of every query form', () => {
    expect(
      filterPaths({
        _where: { 'owner.email_contains': 'a', _or: [{ 'contact.id_in': [1] }] },
        filters: { owner: { email: { $eq: 'x' } } },
        _sort: 'owner.username:ASC',
        _limit: '5',
        populate: '*',
      }),
    ).toEqual([['owner', 'email'], ['contact', 'id'], ['owner', 'email'], ['owner', 'username']]);
  });
});

describe('hidden user fields for members (issues/391)', () => {
  it.each([
    ['plugin::users-permissions.user.find', { _where: { email_contains: 'webcoop' } }],
    ['plugin::users-permissions.user.find', { _where: { 'permissions.permission': 'admin' } }],
    ['plugin::users-permissions.user.find', { _sort: 'email:ASC' }],
    ['api::contact.contact.find', { _where: { 'owner.email_contains': 'a' } }],
    ['api::contact.contact.find', { filters: { owner: { email: { $startsWith: 'a' } } } }],
  ])('%s %p is refused', async (handler, query) => {
    await expect(get(setup(['orders']), handler, query)).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('keeps the filters on what she sees', async () => {
    const { next } = await get(setup(['orders']), 'api::contact.contact.find', { _where: { 'owner.id': ME, name_contains: 'Cal' } });
    expect(next).toHaveBeenCalled();
  });

  it('leaves workers and the office their user filters', async () => {
    const { next } = await get(setup(['orders_admin']), 'plugin::users-permissions.user.find', { _where: { email_contains: 'a' } });
    expect(next).toHaveBeenCalled();
  });
});

describe('_q for users without full access (issues/391)', () => {
  it('searches only the project name', async () => {
    const { ctx, next } = await get(setup(['hours']), 'api::project.project.findWithBasicInfo', { _q: 'interseccional', _limit: '-1' });
    expect(next).toHaveBeenCalled();
    expect(ctx.query._q).toBeUndefined();
    expect(ctx.query._where._and[0]._or.map((c) => Object.keys(c)[0])).toEqual([
      'name_contains',
      'description_contains',
      'purpose_contains',
      'grantable_reference_contains',
    ]);
  });

  it('searches only the name for a member, who sees nothing else of a project', async () => {
    const { ctx } = await get(setup(['orders']), 'api::project.project.findWithBasicInfo', { _q: 'x' });
    expect(ctx.query._where._and[0]).toEqual({ _or: [{ name_contains: 'x' }] });
  });

  it('a member lists users with _limit and sort by name', async () => {
    const { next } = await get(setup(['orders']), 'plugin::users-permissions.user.find', { limit: '-1', start: '0', sort: 'username:ASC' });
    expect(next).toHaveBeenCalled();
  });

  it('leaves full-access users the full search', async () => {
    const { ctx } = await get(setup(['projects']), 'api::project.project.findWithBasicInfo', { _q: 'x' });
    expect(ctx.query._q).toBe('x');
  });
});

describe('/phase-incomes/assigned for users without full access (issues/391)', () => {
  it('keeps only _limit', async () => {
    const { ctx, next } = await get(setup(['orders']), 'api::phase-income.phase-income.findAssigned', {
      _limit: '-1',
      _where: { amount_gt: 1000, 'invoice.contact.name_contains': 'x' },
    });
    expect(next).toHaveBeenCalled();
    expect(ctx.query).toEqual({ _limit: '-1' });
  });
});

describe('task comments for workers (issues/391)', () => {
  it('are not filterable', async () => {
    await expect(
      get(setup(['hours']), 'api::task.task.find', { filters: { task_comments: { text: { $contains: 'sou' } } } }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});
