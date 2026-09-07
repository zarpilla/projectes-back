'use strict';

/**
 * Encryption at rest for the secrets the app replays verbatim.
 *
 * These cannot be hashed — a certificate passphrase has to reach OpenSSL
 * intact — so they are encrypted instead. See services/secret-crypto.js.
 */

const crypto = require('crypto');
const {
  PREFIX,
  SECRET_FIELDS,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  encryptSecretFields,
  resetKeyCache,
} = require('../src/services/secret-crypto');

const KEY = crypto.randomBytes(32).toString('hex');

beforeEach(() => {
  process.env.SECRETS_KEY = KEY;
  resetKeyCache();
});

afterEach(() => {
  delete process.env.SECRETS_KEY;
  resetKeyCache();
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a passphrase unchanged', () => {
    const secret = 'Lampara123!';
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it('round-trips a long API key', () => {
    const token = crypto.randomBytes(32).toString('hex');
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('marks what it produced', () => {
    expect(encryptSecret('x').startsWith(PREFIX)).toBe(true);
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('Lampara123!')).toBe(false);
  });

  it('is idempotent, so writing twice cannot double-encrypt', () => {
    const once = encryptSecret('secret');
    expect(encryptSecret(once)).toBe(once);
    expect(decryptSecret(encryptSecret(once))).toBe('secret');
  });

  it('uses a fresh IV, so equal secrets do not look equal', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('passes legacy plaintext through, so rows migrated from v3 keep working', () => {
    expect(decryptSecret('Lampara123!')).toBe('Lampara123!');
  });

  it('leaves empty values alone', () => {
    for (const empty of [null, undefined, '']) {
      expect(encryptSecret(empty)).toBe(empty);
      expect(decryptSecret(empty)).toBe(empty);
    }
  });

  it('refuses a tampered value rather than returning garbage', () => {
    // AES-GCM authenticates: flipping a byte must fail, not decrypt to noise.
    const stored = encryptSecret('secret');
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered = PREFIX + raw.toString('base64');
    expect(() => decryptSecret(tampered)).toThrow(/Cannot decrypt/);
  });

  it('fails loudly when the key changed, instead of silently succeeding', () => {
    const stored = encryptSecret('secret');
    process.env.SECRETS_KEY = crypto.randomBytes(32).toString('hex');
    resetKeyCache();
    expect(() => decryptSecret(stored)).toThrow(/Cannot decrypt/);
  });

  it('rejects a key that is not 32 bytes', () => {
    process.env.SECRETS_KEY = 'too-short';
    resetKeyCache();
    expect(() => encryptSecret('secret')).toThrow(/32 bytes/);
  });
});

describe('encryptSecretFields', () => {
  it('encrypts only the declared fields of that content type', () => {
    const data = { certificate_password: 'pw', mode: 'test', software_name: 'X' };
    encryptSecretFields(data, 'api::verifactu.verifactu');
    expect(isEncrypted(data.certificate_password)).toBe(true);
    expect(data.mode).toBe('test');
    expect(data.software_name).toBe('X');
  });

  it('ignores fields absent from the payload — a partial save must not blank them', () => {
    const data = { mode: 'test' };
    encryptSecretFields(data, 'api::verifactu.verifactu');
    expect(Object.prototype.hasOwnProperty.call(data, 'certificate_password')).toBe(false);
  });

  it('covers every secret on the me settings', () => {
    expect(SECRET_FIELDS['api::me.me']).toEqual(
      expect.arrayContaining([
        'face_certificate_password',
        'certificate_pwd',
        'dir3_api_token',
        'invoice_parser_api_token',
      ]),
    );
  });

  it('does nothing for a content type with no secrets', () => {
    const data = { name: 'x' };
    expect(encryptSecretFields(data, 'api::project.project')).toEqual({ name: 'x' });
  });
});
