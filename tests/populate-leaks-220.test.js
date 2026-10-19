'use strict';

/**
 * issues/220 (2026-10-19), follow-up of 188: three populate paths still gave
 * users without full access what their role can't read directly:
 * - `/tasks?populate[project][populate][documents]` (or through `/users`) the
 *   project's documents (name, URL, size) while `/projects` is 403;
 * - `/tasks?populate[task_comments]` the comments, while `/task-comments` is 403;
 * - `/users/me?populate[daily_dedications]` her own salary fields, which
 *   `/daily-dedications` strips.
 */

const ME = 100;
const USER = 'plugin::users-permissions.user';

const contentTypes = {
  'api::task.task': {
    attributes: {
      project: { type: 'relation', target: 'api::project.project' },
      task_comments: { type: 'relation', target: 'api::task-comment.task-comment' },
      documents: { type: 'media', multiple: true },
    },
  },
  'api::project.project': {
    attributes: {
      documents: { type: 'media', multiple: true },
      mother: { type: 'relation', target: 'api::project.project' },
    },
  },
  'api::task-comment.task-comment': { attributes: {} },
  'api::daily-dedication.daily-dedication': { attributes: {} },
  [USER]: {
    attributes: {
      tasks: { type: 'relation', target: 'api::task.task' },
      daily_dedications: { type: 'relation', target: 'api::daily-dedication.daily-dedication' },
    },
  },
};

function makeStrapi(permissions) {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) =>
      uid === USER ? { id: where.id, permissions: permissions.map((permission) => ({ permission })) } : null,
    ),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  });
  return { db: { query: jest.fn(query) }, contentTypes, components: {} };
}

async function call(permissions, handler, answer) {
  jest.resetModules();
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi: makeStrapi(permissions) });
  const ctx = {
    method: 'GET',
    query: {},
    params: {},
    request: {},
    state: { user: { id: ME }, route: { handler, info: {} } },
  };
  await middleware(
    ctx,
    jest.fn(async () => {
      ctx.body = answer;
    }),
  );
  return ctx;
}

const file = { id: 31, name: 'conveni.pdf', url: '/uploads/conveni_1a2b.pdf', size: 120.5 };
const project = () => ({ id: 2, name: 'Diligència', total_real_hours: 30, documents: [file] });

describe('populates into what the role cannot read (issues/220)', () => {
  it("a worker gets a task's project (and its mother) without the documents", async () => {
    const answer = { data: [{ id: 1, project: { ...project(), mother: project() } }], meta: {} };
    const ctx = await call(['hours'], 'api::task.task.find', answer);
    expect(ctx.body.data[0].project.documents).toBeUndefined();
    expect(ctx.body.data[0].project.mother.documents).toBeUndefined();
    expect(ctx.body.data[0].project.name).toBe('Diligència');
  });

  it('the same through the people list', async () => {
    const answer = [{ id: 3, tasks: [{ id: 1, project: project() }] }];
    const ctx = await call(['hours'], 'plugin::users-permissions.user.find', answer);
    expect(ctx.body[0].tasks[0].project).toEqual({ id: 2, name: 'Diligència', total_real_hours: 30 });
  });

  it.each([['orders'], ['orders_delivery'], ['orders_admin']])(
    '%s gets the project picker (findWithBasicInfo) without the documents',
    async (permission) => {
      const ctx = await call([permission], 'api::project.project.findWithBasicInfo', [project()]);
      expect(ctx.body[0]).toEqual({ id: 2, name: 'Diligència', total_real_hours: 30 });
    },
  );

  it('nor a worker in phases-both', async () => {
    const phases = await call(['hours'], 'api::project.project.findWithPhasesBoth', [project()]);
    expect(phases.body[0].documents).toBeUndefined();
  });

  it('a worker keeps the documents of the task itself, but not its comments', async () => {
    const answer = {
      data: [{ id: 134, name: 'Memòria', documents: [file], task_comments: [{ id: 5, comment: 'privat' }] }],
      meta: {},
    };
    const ctx = await call(['hours'], 'api::task.task.findOne', answer);
    expect(ctx.body.data[0].task_comments).toBeUndefined();
    expect(ctx.body.data[0].documents).toEqual([file]);
  });

  it('the full-access users keep documents and comments', async () => {
    const answer = { data: [{ id: 134, project: project(), task_comments: [{ id: 5 }] }], meta: {} };
    const ctx = await call(['projects'], 'api::task.task.find', answer);
    expect(ctx.body.data[0].project.documents).toEqual([file]);
    expect(ctx.body.data[0].task_comments).toEqual([{ id: 5 }]);
  });

  it('users/me gives her own working periods without the salary fields', async () => {
    const answer = {
      id: ME,
      username: 'prova.hores',
      ical: 'https://calendar.example/private.ics',
      identity_number: '00000000T',
      monthly_salary: 2000,
      cost_by_hour: 15,
      permissions: [{ permission: 'hours' }],
      daily_dedications: [
        {
          id: 7,
          from: '2026-01-01',
          hours: 8,
          monthly_salary: 2000,
          costByHour: 15,
          scheme: 'general',
          quota: 300,
          pct_irpf: 15,
          pct_other: 1,
          pct_quota: 30,
        },
      ],
    };
    const ctx = await call(['hours'], 'plugin::users-permissions.user.me', answer);
    expect(ctx.body.daily_dedications).toEqual([{ id: 7, from: '2026-01-01', hours: 8 }]);
    expect(ctx.body.monthly_salary).toBeUndefined();
    expect(ctx.body.cost_by_hour).toBeUndefined();
    // her own row keeps what «Hores dedicades» and «Registre jornades» read
    expect(ctx.body.ical).toBe('https://calendar.example/private.ics');
    expect(ctx.body.identity_number).toBe('00000000T');
    expect(ctx.body.permissions).toEqual([{ permission: 'hours' }]);
  });

  it('users/me of a full-access user is left alone', async () => {
    const answer = { id: ME, monthly_salary: 2000, daily_dedications: [{ id: 7, monthly_salary: 2000 }] };
    const ctx = await call(['admin'], 'plugin::users-permissions.user.me', answer);
    expect(ctx.body.daily_dedications).toEqual([{ id: 7, monthly_salary: 2000 }]);
  });
});
