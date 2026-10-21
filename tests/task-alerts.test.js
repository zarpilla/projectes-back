'use strict';

/**
 * issues/307 (2026-10-21): the Tasques menu dot asked, on every page load and
 * every 5 minutes, the person's tasks with everything populated (~40 KB: the
 * whole project, the people, the checklist, the creator), the task states and
 * her mentions, to count two numbers in the browser. GET /api/tasks/alerts
 * counts them here, on the few fields they need, with the same rules (the
 * front's cases are kept below).
 */

const { taskAlerts } = require('../src/api/task/services/alerts');

const states = [{ id: 1, order: 0 }, { id: 3, order: 2 }];
const me = 5;
const today = '2026-10-17';
const seenAt = '2026-10-16T10:00:00.000Z';

describe('task alerts (the front rules, now on the server)', () => {
  it('counts my overdue tasks and checklist items, not done or archived ones', () => {
    const tasks = [
      { id: 1, users_permissions_users: [{ id: me }], task_state: { id: 1 }, due_date: '2026-10-10', created: { id: me }, createdAt: '2026-01-01' },
      { id: 2, users_permissions_users: [{ id: me }], task_state: { id: 3 }, due_date: '2026-10-10', created: { id: me } },
      { id: 3, users_permissions_users: [{ id: me }], task_state: { id: 1 }, due_date: '2026-10-10', archived: true },
      {
        id: 4,
        users_permissions_users: [{ id: me }],
        task_state: { id: 1 },
        created: { id: me },
        checklist: [
          { user: { id: me }, done: false, due_date: '2026-10-01' },
          { user: { id: me }, done: true, due_date: '2026-10-01' },
          { user: { id: 9 }, done: false, due_date: '2026-10-01' },
        ],
      },
    ];
    expect(taskAlerts({ tasks, states, me, seenAt, today })).toEqual({ overdue: 2, fresh: 0 });
  });

  it('counts tasks others created for me and mentions since I last looked', () => {
    const tasks = [
      { id: 1, users_permissions_users: [{ id: me }], task_state: { id: 1 }, created: { id: 8 }, createdAt: '2026-10-17T08:00:00.000Z' },
      { id: 2, users_permissions_users: [{ id: me }], task_state: { id: 1 }, created: { id: 8 }, createdAt: '2026-10-15T08:00:00.000Z' },
      { id: 3, users_permissions_users: [{ id: me }], task_state: { id: 1 }, created: { id: me }, createdAt: '2026-10-17T08:00:00.000Z' },
    ];
    const mentions = [
      { createdAt: '2026-10-17T09:00:00.000Z', author: { id: 8 } },
      { createdAt: '2026-10-17T09:00:00.000Z', author: { id: me } },
    ];
    expect(taskAlerts({ tasks, states, mentions, me, seenAt, today })).toEqual({ overdue: 0, fresh: 2 });
  });

  it('reads dates as the database gives them (Date objects too)', () => {
    const tasks = [
      { id: 1, users_permissions_users: [{ id: me }], task_state: { id: 1 }, created: { id: 8 }, createdAt: new Date('2026-10-17T08:00:00.000Z') },
      { id: 2, users_permissions_users: [{ id: me }], task_state: { id: 1 }, created: { id: 8 }, createdAt: new Date('2026-10-15T08:00:00.000Z') },
    ];
    expect(taskAlerts({ tasks, states, me, seenAt, today })).toEqual({ overdue: 0, fresh: 1 });
  });
});

describe('GET /api/tasks/alerts', () => {
  let controller;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    calls = [];
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const rows = {
      'api::task.task': [
        { id: 1, users_permissions_users: [{ id: me }], task_state: { id: 1 }, due_date: '2026-10-10', created: { id: 8 }, createdAt: '2026-10-17T08:00:00.000Z' },
      ],
      'api::task-state.task-state': states,
      'api::task-comment.task-comment': [{ createdAt: '2026-10-17T09:00:00.000Z', author: { id: 8 } }],
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls.push([uid, args]);
            return rows[uid] || [];
          },
        }),
      },
    };
    controller = require('../src/api/task/controllers/task')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ask = (query, user = { id: me }) =>
    controller.alerts({ query, state: { user }, unauthorized: () => 'unauthorized' });

  it('answers the two numbers of the person asking', async () => {
    expect(await ask({ seen: seenAt, today })).toEqual({ overdue: 1, fresh: 2 });
  });

  it('asks only her open tasks, with the fields the rules read', async () => {
    await ask({ seen: seenAt, today });
    const [, tasks] = calls.find(([uid]) => uid === 'api::task.task');
    expect(tasks.where).toEqual({ archived: false, users_permissions_users: { id: me } });
    expect(tasks.select).toEqual(['id', 'due_date', 'archived', 'createdAt']);
    // no project, no description, no whole users
    expect(Object.keys(tasks.populate).sort()).toEqual(['checklist', 'created', 'task_state', 'users_permissions_users']);
    expect(tasks.populate.users_permissions_users).toEqual({ select: ['id'] });
    const [, comments] = calls.find(([uid]) => uid === 'api::task-comment.task-comment');
    expect(comments.where).toEqual({ mentions: { id: me }, createdAt: { $gt: seenAt } });
  });

  it('takes the server day when the browser sends none, and refuses without a user', async () => {
    await expect(ask({ seen: seenAt })).resolves.toHaveProperty('overdue');
    expect(await ask({ seen: seenAt, today }, null)).toBe('unauthorized');
  });
});
