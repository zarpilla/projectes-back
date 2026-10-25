// «Còpia de seguretat» (2026-10-24): an app admin downloads last night's dump
// of the entity's own database. The host writes it to <dir>/latest.sql.gz
// (deploy/docker/tenant-dumps.sh); the routes are admin-only.
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
let controller;

const ctxFor = (user = { id: 7, email: 'admin@example.org' }) => {
  const headers = {};
  return {
    state: { user },
    headers,
    set: (k, v) => { headers[k] = v; },
    notFound: jest.fn((msg) => ({ notFound: msg })),
    body: undefined,
  };
};

beforeEach(() => {
  jest.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  process.env.TENANT_BACKUP_DIR = dir;
  process.env.DATABASE_NAME = 'diligencia_v5';
  global.strapi = { log: { info: jest.fn(), warn: jest.fn() } };
  controller = require('../src/api/backup/controllers/backup')();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TENANT_BACKUP_DIR;
});

const writeDump = (content = 'dump', when = new Date('2026-10-24T01:05:00Z')) => {
  const file = path.join(dir, 'latest.sql.gz');
  fs.writeFileSync(file, content);
  fs.utimesSync(file, when, when);
};

describe('backup controller', () => {
  it('says there is no copy when the host has not written one', async () => {
    expect(await controller.latest()).toEqual({ enabled: true, available: false });
    const ctx = ctxFor();
    await controller.download(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
    expect(ctx.body).toBeUndefined();
  });

  it('describes the latest copy', async () => {
    writeDump('0123456789');
    expect(await controller.latest()).toEqual({
      enabled: true,
      available: true,
      createdAt: '2026-10-24T01:05:00.000Z',
      bytes: 10,
      filename: 'diligencia_v5-20261024.sql.gz',
    });
  });

  it('streams the file as an attachment and logs who took it', async () => {
    writeDump('0123456789');
    const ctx = ctxFor();
    await controller.download(ctx);
    expect(ctx.headers['Content-Type']).toBe('application/gzip');
    expect(ctx.headers['Content-Length']).toBe('10');
    expect(ctx.headers['Content-Disposition']).toBe('attachment; filename="diligencia_v5-20261024.sql.gz"');
    expect(typeof ctx.body.pipe).toBe('function');
    const chunks = [];
    for await (const chunk of ctx.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('0123456789');
    expect(global.strapi.log.info).toHaveBeenCalledWith(expect.stringContaining('downloaded by user 7'));
  });
});

describe('a tenant without copies (tenant-dumps.skip, e.g. demo)', () => {
  it('has no backups folder: not enabled, and nothing to download', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await controller.latest()).toEqual({ enabled: false, available: false });
    const ctx = ctxFor();
    await controller.download(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
    expect(ctx.body).toBeUndefined();
  });
});

describe('backup download while tonight\'s copy replaces the file', () => {
  it('streams the file it opened, with that file\'s size', async () => {
    writeDump('old-copy');
    const ctx = ctxFor();
    await controller.download(ctx);
    // tenant-dumps.sh writes a temporary file and renames it over latest.sql.gz
    const tmp = path.join(dir, '.latest.sql.gz.tmp');
    fs.writeFileSync(tmp, 'a much longer new copy');
    fs.renameSync(tmp, path.join(dir, 'latest.sql.gz'));
    const chunks = [];
    for await (const chunk of ctx.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('old-copy');
    expect(ctx.headers['Content-Length']).toBe('8');
  });
});

describe('backup routes', () => {
  it('are admin-only', () => {
    const { routes } = require('../src/api/backup/routes/backup');
    expect(routes).toHaveLength(2);
    for (const route of routes) expect(route.config.policies).toEqual(['global::isAdmin']);
  });
});
