/**
 * Regression (issues/028, 2026-10-10): `projects/:id`, `projects/basic`,
 * `projects/:id/phases` and `project-original-phases-hours` answered with the
 * password hash and reset-password token of every user they populated — the
 * ported controllers return raw `strapi.db.query` rows, which are not
 * sanitized. Guards the middleware that removes them from every API answer.
 */

const middleware = require('../src/middlewares/strip-user-secrets');

const user = () => ({
  id: 3,
  username: 'maria',
  email: 'maria@example.org',
  password: '$2a$10$hash',
  resetPasswordToken: 'reset-token',
  confirmationToken: 'confirm-token',
});

const run = async (path, body) => {
  const ctx = { path };
  await middleware()(ctx, async () => {
    ctx.body = body;
  });
  return ctx.body;
};

describe('strip-user-secrets', () => {
  it('removes the credentials of users nested anywhere in the answer', async () => {
    const body = await run('/api/projects/7', {
      id: 7,
      leader: user(),
      project_phases: [{ incomes: [{ estimated_hours: [{ quantity: 2, users_permissions_user: user() }] }] }],
    });
    expect(JSON.stringify(body)).not.toMatch(/hash|reset-token|confirm-token/);
    expect(body.leader).toEqual({ id: 3, username: 'maria', email: 'maria@example.org' });
    expect(body.project_phases[0].incomes[0].estimated_hours[0].quantity).toBe(2);
  });

  it('covers lists and the { data } envelope', async () => {
    expect(JSON.stringify(await run('/api/projects/basic', [{ leader: user() }, { leader: user() }]))).not.toMatch(/hash/);
    expect(JSON.stringify(await run('/api/users', { data: [user()] }))).not.toMatch(/hash/);
  });

  it('leaves everything else as it was', async () => {
    const body = { id: 1, date: new Date('2026-01-02'), lines: [{ base: 10 }], name: null, note: 'password reset sent' };
    expect(await run('/api/tasks/1', body)).toEqual({
      id: 1,
      date: new Date('2026-01-02'),
      lines: [{ base: 10 }],
      name: null,
      note: 'password reset sent',
    });
  });

  it('does not touch files, text or empty answers', async () => {
    const buffer = Buffer.from('pdf');
    expect(await run('/api/emitted-invoices/pdf/x/1', buffer)).toBe(buffer);
    expect(await run('/api/x', 'plain text')).toBe('plain text');
    expect(await run('/api/x', undefined)).toBeUndefined();
  });

  it('only acts on the API (the admin panel manages users through its own routes)', async () => {
    const body = await run('/admin/users/me', { data: user() });
    expect(body.data.password).toBe('$2a$10$hash');
  });

  it('is registered in the middleware stack, inside compression', () => {
    const env = Object.assign(() => undefined, { bool: (key, fallback) => fallback });
    const names = require('../config/middlewares')({ env }).map((entry) => (typeof entry === 'string' ? entry : entry.name));
    expect(names).toContain('global::strip-user-secrets');
    expect(names.indexOf('strapi::compression')).toBeLessThan(names.indexOf('global::strip-user-secrets'));
  });
});
