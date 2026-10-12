'use strict';

/**
 * Regression: issues/037 (2026-10-12) — FACe submissions could not be signed
 * in Docker.
 *
 * generateFaceJWT() extracted the certificate and the private key from the
 * tenant's PKCS#12 file by running `openssl pkcs12 ...`. The backend image
 * (node:20-bookworm-slim) has no openssl binary, so sending an invoice to FACe
 * and checking its status both failed. Same family as issues/036 (pdftk).
 *
 * Guards:
 *   - the JWT is built without spawning any process;
 *   - it carries the client certificate, not a CA of the chain stored in the
 *     same file (what `openssl pkcs12 -clcerts` selected);
 *   - the signature verifies against that certificate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const FACE_JWT = path.join(__dirname, '..', 'src', 'api', 'face-queue', 'utils', 'face-jwt.js');

const keyPair = () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(privateKey);
  return { privateKey: key, publicKey: forge.pki.setRsaPublicKey(key.n, key.e) };
};

const certificate = (serial, subjectName, subjectKey, issuerName, issuerKey) => {
  const cert = forge.pki.createCertificate();
  cert.publicKey = subjectKey.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2036-01-01T00:00:00Z');
  cert.setSubject([{ name: 'commonName', value: subjectName }]);
  cert.setIssuer([{ name: 'commonName', value: issuerName }]);
  cert.sign(issuerKey.privateKey, forge.md.sha256.create());
  return cert;
};

const derBase64 = (cert) => forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('generateFaceJWT without openssl', () => {
  const PASSWORD = 'secret';
  let tmp;
  let p12Path;
  let client;
  let spawned;
  let generateFaceJWT;

  beforeAll(() => {
    const caKey = keyPair();
    const clientKey = keyPair();
    const ca = certificate('01', 'Test CA', caKey, 'Test CA', caKey);
    client = certificate('02', 'Cooperativa SCCL', clientKey, 'Test CA', caKey);

    // The CA goes first, as some issuers export it: the first certificate of
    // the file is not the one to send.
    const p12 = forge.pkcs12.toPkcs12Asn1(clientKey.privateKey, [ca, client], PASSWORD, { algorithm: '3des' });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'face-jwt-'));
    p12Path = path.join(tmp, 'cert.p12');
    fs.writeFileSync(p12Path, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.resetModules();
    spawned = [];
    // No openssl (nor anything else) on this machine.
    jest.doMock('child_process', () => {
      const fail = (...args) => {
        spawned.push(args[0]);
        throw new Error('/bin/sh: 1: openssl: not found');
      };
      return { ...jest.requireActual('child_process'), execSync: fail, exec: fail, execFile: fail, spawn: fail };
    });
    global.strapi = { log: { error: () => {} } };
    ({ generateFaceJWT } = require(FACE_JWT));
  });

  afterEach(() => {
    delete global.strapi;
    jest.dontMock('child_process');
  });

  it('builds the JWT in-process with the client certificate', () => {
    const jwt = generateFaceJWT(p12Path, PASSWORD);

    expect(spawned).toEqual([]);
    const [header, payload, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ typ: 'JWT', alg: 'RS256', x5c: [derBase64(client)] });

    const claims = decode(payload);
    expect(claims.username).toBe(crypto.createHash('sha1').update(derBase64(client)).digest('hex'));
    expect(claims.exp - claims.iat).toBe(300);

    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      forge.pki.certificateToPem(client),
      Buffer.from(signature, 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('fails with a clear error on a wrong password', () => {
    expect(() => generateFaceJWT(p12Path, 'wrong')).toThrow(/Failed to generate FACe JWT/);
    expect(spawned).toEqual([]);
  });
});
