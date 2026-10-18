'use strict';

/**
 * The AEAT (VeriFactu) and FACe certificates, managed from the app (ticket 159).
 *
 * Until now the .p12 had to be uploaded, and its password set, from the Strapi
 * admin, and nobody could tell from the app whether the password opened it or
 * when the certificate expired. GET /api/face-queues/verify-setup also handed
 * the certificate's path on disk to any logged-in user.
 *
 * These guard that: the status is read from the keystore with the stored
 * (encrypted) password and never carries the password, the URL or a path; a
 * file the password does not open, or without its private key, is refused
 * before anything is stored; a replaced file is deleted unless the other kind
 * still uses it; and only admins reach the routes.
 *
 * The keystores are throwaway self-signed ones made here with node-forge.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const KEY = crypto.randomBytes(32).toString('hex');
const PASSWORD = 'prova-159';

let keys;

function makePkcs12({ password = PASSWORD, withKey = true, notAfter = new Date('2027-03-01') } = {}) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-03-01');
  cert.validity.notAfter = notAfter;
  cert.setSubject([
    { name: 'commonName', value: 'ENTITAT DE PROVA - B12345678' },
    { name: 'organizationName', value: 'Entitat de Prova SCCL' },
    { type: '2.5.4.97', value: 'VATES-B12345678' },
    { type: '2.5.4.5', value: 'IDCES-12345678Z' },
  ]);
  cert.setIssuer([{ name: 'commonName', value: 'AC Prova' }, { name: 'organizationName', value: 'Prova' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(withKey ? keys.privateKey : null, [cert], password);
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

beforeAll(() => {
  keys = forge.pki.rsa.generateKeyPair(1024);
});

describe('inspectPkcs12', () => {
  const { inspectPkcs12, stripIdentifierPrefix } = require('../src/services/pkcs12-info');

  it('reads holder, NIF, issuer and validity when the password opens it', () => {
    const result = inspectPkcs12(makePkcs12(), PASSWORD);
    expect(result).toEqual({
      valid: true,
      error: null,
      message: null,
      certificate: {
        subject: { commonName: 'ENTITAT DE PROVA - B12345678', organization: 'Entitat de Prova SCCL' },
        nif: 'B12345678',
        issuer: { commonName: 'AC Prova', organization: 'Prova' },
        notBefore: '2026-03-01T00:00:00.000Z',
        notAfter: '2027-03-01T00:00:00.000Z',
      },
    });
  });

  it('reports a wrong password', () => {
    const result = inspectPkcs12(makePkcs12(), 'una altra');
    expect(result).toMatchObject({ valid: false, error: 'wrong_password', certificate: null });
    expect(result.message).toBe('La contrasenya no obre el certificat.');
  });

  it('refuses a keystore without the private key', () => {
    expect(inspectPkcs12(makePkcs12({ withKey: false }), PASSWORD)).toMatchObject({
      valid: false,
      error: 'no_key',
    });
  });

  it('refuses a file that is not PKCS#12', () => {
    expect(inspectPkcs12(Buffer.from('no és un certificat'), PASSWORD)).toMatchObject({
      valid: false,
      error: 'not_pkcs12',
    });
  });

  it('strips the ETSI identifier prefixes', () => {
    expect(stripIdentifierPrefix('VATES-B12345678')).toBe('B12345678');
    expect(stripIdentifierPrefix('IDCES-12345678Z')).toBe('12345678Z');
    expect(stripIdentifierPrefix('12345678Z')).toBe('12345678Z');
  });
});

describe('certificates service and controller', () => {
  let publicDir;
  let store;
  let updates;
  let uploads;
  let removed;
  let nextId;
  let secretCrypto;
  let certificates;

  /** Writes a keystore into the stub public dir as an uploaded media file. */
  function mediaFile(buffer, name = 'certificat.p12') {
    const id = nextId++;
    const url = `/uploads/cert_${id}.p12`;
    fs.mkdirSync(path.join(publicDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, url), buffer);
    return { id, name, url, createdAt: '2026-10-01T09:00:00.000Z' };
  }

  /** A multipart file as koa-body (formidable) hands it to the controller. */
  function multipart(buffer, name = 'nou.p12') {
    const filepath = path.join(os.tmpdir(), `cert-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(filepath, buffer);
    return { filepath, originalFilename: name, size: buffer.length, mimetype: 'application/octet-stream' };
  }

  beforeEach(() => {
    jest.resetModules();
    process.env.SECRETS_KEY = KEY;
    secretCrypto = require('../src/services/secret-crypto');
    secretCrypto.resetKeyCache();

    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-public-'));
    nextId = 100;
    store = {
      'api::verifactu.verifactu': { documentId: 'v1', mode: 'test' },
      'api::me.me': { documentId: 'm1', name: 'Entitat' },
    };
    updates = [];
    uploads = [];
    removed = [];

    global.strapi = {
      dirs: { static: { public: publicDir } },
      documents: (uid) => ({
        findFirst: async () => (store[uid] ? { ...store[uid] } : null),
        update: async ({ documentId, data }) => {
          updates.push({ uid, documentId, data });
          // what the lifecycle does on the way to the database
          const row = { ...data };
          secretCrypto.encryptSecretFields(row, uid);
          for (const [field, value] of Object.entries(row)) {
            store[uid][field] = typeof value === 'number' ? uploads.find((f) => f.id === value) : value;
          }
          return store[uid];
        },
        create: async () => {
          throw new Error('not expected');
        },
      }),
      plugin: () => ({
        service: () => ({
          upload: async ({ data, files }) => {
            const file = { ...mediaFile(fs.readFileSync(files.filepath), data.fileInfo.name), mime: files.mimetype };
            uploads.push(file);
            return [file];
          },
          remove: async (file) => removed.push(file.id),
        }),
      }),
    };

    certificates = require('../src/services/certificates');
  });

  afterEach(() => {
    fs.rmSync(publicDir, { recursive: true, force: true });
    delete global.strapi;
    delete process.env.SECRETS_KEY;
    secretCrypto.resetKeyCache();
  });

  describe('getStatus', () => {
    it('says not configured when there is no file', async () => {
      expect(await certificates.getStatus('face')).toMatchObject({
        kind: 'face',
        configured: false,
        valid: false,
        certificate: null,
      });
    });

    it('opens the keystore with the stored (encrypted) password, without returning secrets', async () => {
      const file = mediaFile(makePkcs12());
      store['api::verifactu.verifactu'].certificate = file;
      store['api::verifactu.verifactu'].certificate_password = secretCrypto.encryptSecret(PASSWORD);

      const status = await certificates.getStatus('verifactu');

      expect(status).toMatchObject({
        configured: true,
        fileName: 'certificat.p12',
        uploadedAt: '2026-10-01T09:00:00.000Z',
        passwordSet: true,
        valid: true,
        error: null,
      });
      expect(status.certificate.nif).toBe('B12345678');
      const json = JSON.stringify(status);
      expect(json).not.toContain(PASSWORD);
      expect(json).not.toContain(file.url);
      expect(json).not.toContain(publicDir);
      expect(json).not.toContain('enc:v1:');
    });

    it('reports a stored password that does not open the file', async () => {
      store['api::me.me'].face_certificate = mediaFile(makePkcs12());
      store['api::me.me'].face_certificate_password = secretCrypto.encryptSecret('dolenta');

      expect(await certificates.getStatus('face')).toMatchObject({
        configured: true,
        valid: false,
        error: 'wrong_password',
        message: 'La contrasenya no obre el certificat.',
      });
    });

    it('reports a linked file that is not on disk', async () => {
      store['api::me.me'].face_certificate = { id: 5, name: 'perdut.p12', url: '/uploads/perdut.p12' };

      expect(await certificates.getStatus('face')).toMatchObject({ configured: true, error: 'file_missing' });
    });
  });

  describe('replace', () => {
    it('refuses a password that does not open the file, storing nothing', async () => {
      await expect(certificates.replace('face', multipart(makePkcs12()), 'dolenta')).rejects.toThrow(
        'La contrasenya no obre el certificat.',
      );
      expect(uploads).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    it('refuses a keystore without the private key', async () => {
      await expect(certificates.replace('face', multipart(makePkcs12({ withKey: false })), PASSWORD)).rejects.toThrow(
        /clau privada/,
      );
      expect(uploads).toHaveLength(0);
    });

    it('refuses a file that is not .p12 or .pfx', async () => {
      await expect(certificates.replace('face', multipart(makePkcs12(), 'cert.pem'), PASSWORD)).rejects.toThrow(
        '.p12 o .pfx',
      );
    });

    it('uploads, links, stores the password encrypted and deletes the previous file', async () => {
      const previous = mediaFile(makePkcs12());
      store['api::me.me'].face_certificate = previous;

      const status = await certificates.replace('face', multipart(makePkcs12(), 'nou.pfx'), PASSWORD);

      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ name: 'nou.pfx', mime: 'application/x-pkcs12' });
      expect(updates).toEqual([
        {
          uid: 'api::me.me',
          documentId: 'm1',
          data: { face_certificate: uploads[0].id, face_certificate_password: PASSWORD },
        },
      ]);
      expect(secretCrypto.isEncrypted(store['api::me.me'].face_certificate_password)).toBe(true);
      expect(removed).toEqual([previous.id]);
      expect(status).toMatchObject({ configured: true, fileName: 'nou.pfx', valid: true });
    });

    it('keeps the previous file when the other certificate still uses it', async () => {
      const shared = mediaFile(makePkcs12());
      store['api::me.me'].face_certificate = shared;
      store['api::verifactu.verifactu'].certificate = shared;

      await certificates.replace('face', multipart(makePkcs12()), PASSWORD);

      expect(removed).toEqual([]);
    });
  });

  describe('remove', () => {
    it('unlinks the file and the password and deletes the file', async () => {
      const file = mediaFile(makePkcs12());
      store['api::verifactu.verifactu'].certificate = file;
      store['api::verifactu.verifactu'].certificate_password = secretCrypto.encryptSecret(PASSWORD);

      const status = await certificates.remove('verifactu');

      expect(updates[0].data).toEqual({ certificate: null, certificate_password: null });
      expect(removed).toEqual([file.id]);
      expect(status.configured).toBe(false);
    });
  });

  describe('controller', () => {
    const ctx = (kind, extra = {}) => ({
      params: { kind },
      request: { body: {}, files: {} },
      notFound: jest.fn(() => 'notFound'),
      badRequest: jest.fn((message) => ({ badRequest: message })),
      ...extra,
    });

    it('answers 404 for an unknown kind', async () => {
      const controller = require('../src/api/certificate/controllers/certificate');
      const c = ctx('altres');
      await controller.status(c);
      expect(c.notFound).toHaveBeenCalled();
    });

    it('answers 400 with the Catalan message and removes the temp file', async () => {
      const controller = require('../src/api/certificate/controllers/certificate');
      const file = multipart(makePkcs12());
      const c = ctx('face', { request: { body: { password: 'dolenta' }, files: { file } } });

      await controller.replace(c);

      expect(c.badRequest).toHaveBeenCalledWith('La contrasenya no obre el certificat.');
      expect(fs.existsSync(file.filepath)).toBe(false);
    });

    it('takes the password from the body', async () => {
      const controller = require('../src/api/certificate/controllers/certificate');
      const c = ctx('verifactu', { request: { body: { password: PASSWORD }, files: { file: multipart(makePkcs12()) } } });

      await controller.replace(c);

      expect(c.body).toMatchObject({ kind: 'verifactu', valid: true });
    });
  });
});

describe('admin only', () => {
  it('puts isAdmin on every certificate route', () => {
    const { routes } = require('../src/api/certificate/routes/certificate');
    expect(routes.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'POST']);
    for (const route of routes) expect(route.config.policies).toContain('global::isAdmin');
  });

  it('puts isAdmin on the FACe setup diagnostic', () => {
    const { routes } = require('../src/api/face-queue/routes/01-custom-face-queue');
    const verify = routes.find((r) => r.handler === 'face-queue.verifySetup');
    expect(verify.config.policies).toContain('global::isAdmin');
  });

  it('grants the certificate actions and the verifactu update to Authenticated', async () => {
    const calls = [];
    global.strapi = {
      service: (name) =>
        name === 'plugin::users-permissions.users-permissions'
          ? {
              getActions: async () => ({
                'api::certificate': { controllers: { certificate: { status: {}, replace: {}, remove: {} } } },
                'api::verifactu': { controllers: { verifactu: { find: {}, update: {}, delete: {} } } },
              }),
            }
          : { updateRole: async (id, body) => calls.push({ id, body }) },
      query: () => ({ findOne: async ({ where }) => ({ id: where.type === 'public' ? 1 : 2, type: where.type }) }),
      log: { warn: () => {}, info: () => {} },
    };
    const { importSeedPermissions } = require('../src/services/bootstrap-permissions');

    await importSeedPermissions();

    const authenticated = calls.find((c) => c.id === 2).body.permissions;
    expect(authenticated['api::certificate'].controllers.certificate).toEqual({
      status: { enabled: true },
      replace: { enabled: true },
      remove: { enabled: true },
    });
    expect(authenticated['api::verifactu'].controllers.verifactu).toEqual({
      find: { enabled: true },
      update: { enabled: true },
    });
    delete global.strapi;
  });
});

describe('verify-setup', () => {
  it('does not return the certificate path or URL', async () => {
    jest.resetModules();
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-public-'));
    fs.mkdirSync(path.join(publicDir, 'uploads'));
    fs.writeFileSync(path.join(publicDir, 'uploads', 'face_abc.p12'), 'x');
    global.strapi = {
      dirs: { static: { public: publicDir } },
      documents: () => ({
        findFirst: async () => ({
          face: 'test',
          nif: 'B12345678',
          face_certificate: { name: 'face.p12', url: '/uploads/face_abc.p12' },
          face_certificate_password: 'enc:v1:xxx',
        }),
      }),
      db: { query: () => ({ findMany: async () => [] }) },
    };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    const controller = require('../src/api/face-queue/controllers/face-queue');
    let sent;
    await controller.verifySetup({ send: (body) => (sent = body) });

    const json = JSON.stringify(sent);
    expect(json).not.toContain('face_abc');
    expect(json).not.toContain(publicDir);
    expect(sent.details.certificate_file.status).toBe(true);
    fs.rmSync(publicDir, { recursive: true, force: true });
    delete global.strapi;
  });
});
