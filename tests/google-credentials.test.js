'use strict';

/**
 * issues/159 (2026-10-18): the Google service-account key that imports the
 * Google Calendar events as hours (Resilience.Earth) could only be uploaded
 * from the Strapi admin. Configuració general now uploads it through
 * /api/certificates/google: only a real service-account key is accepted, the
 * status shows the account but never the private key, URL or path, and a
 * replaced file is deleted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = { type: 'service_account', project_id: 'prova', private_key_id: 'abc', private_key: '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n', client_email: 'hores@prova.iam.gserviceaccount.com' };

let dir;
let me;
let removed;

const tmpFile = (name, content) => {
  const filepath = path.join(dir, `${Math.random()}-${name}`);
  fs.writeFileSync(filepath, content);
  return { filepath, originalFilename: name, size: Buffer.byteLength(content) };
};

beforeEach(() => {
  jest.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-159-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  me = { documentId: 'me1', google_credentials: null };
  removed = [];
  let nextId = 10;
  global.strapi = {
    dirs: { static: { public: dir } },
    documents: () => ({
      findFirst: async () => me,
      update: async ({ data }) => {
        if ('google_credentials' in data) me.google_credentials = data.google_credentials && me._uploaded[data.google_credentials];
      },
    }),
    plugin: () => ({
      service: () => ({
        upload: async ({ files }) => {
          const id = nextId++;
          const url = `/uploads/key_${id}.json`;
          fs.copyFileSync(files.filepath, path.join(dir, url));
          me._uploaded = { ...(me._uploaded || {}), [id]: { id, name: files.originalFilename, url, mime: files.mimetype } };
          return [me._uploaded[id]];
        },
        remove: async (file) => removed.push(file.id),
      }),
    }),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete global.strapi;
});

describe('Google service-account key (issues/159)', () => {
  it('accepts a service-account key and shows its account, never the key', async () => {
    const google = require('../src/services/google-credentials');
    const status = await google.replace(tmpFile('clau.json', JSON.stringify(KEY)));
    expect(status).toMatchObject({ configured: true, valid: true, fileName: 'clau.json', account: { clientEmail: KEY.client_email, projectId: 'prova', keyId: 'abc' } });
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(status)).not.toContain('/uploads/');
    expect(me.google_credentials.mime).toBe('application/json');
  });

  it('refuses what is not a service-account key', async () => {
    const google = require('../src/services/google-credentials');
    await expect(google.replace(tmpFile('clau.txt', '{}'))).rejects.toThrow('.json');
    await expect(google.replace(tmpFile('clau.json', 'no json'))).rejects.toThrow('JSON vàlid');
    await expect(google.replace(tmpFile('clau.json', JSON.stringify({ ...KEY, private_key: undefined })))).rejects.toThrow('compte de servei');
    expect(me.google_credentials).toBeNull();
  });

  it('deletes the previous file on replace and on remove', async () => {
    const google = require('../src/services/google-credentials');
    await google.replace(tmpFile('a.json', JSON.stringify(KEY)));
    await google.replace(tmpFile('b.json', JSON.stringify(KEY)));
    expect(removed).toEqual([10]);
    const status = await google.remove();
    expect(removed).toEqual([10, 11]);
    expect(status.configured).toBe(false);
  });
});

describe('/api/certificates/google', () => {
  it('routes the google kind to the key, the rest stays 404', async () => {
    jest.doMock('../src/services/google-credentials', () => ({ getStatus: async () => ({ kind: 'google' }) }));
    const controller = require('../src/api/certificate/controllers/certificate');
    const ctx = { params: { kind: 'google' }, notFound: jest.fn(() => 'NOT_FOUND') };
    await controller.status(ctx);
    expect(ctx.body).toEqual({ kind: 'google' });
    const other = { params: { kind: 'other' }, notFound: jest.fn(() => 'NOT_FOUND') };
    await controller.status(other);
    expect(other.notFound).toHaveBeenCalled();
  });
});
