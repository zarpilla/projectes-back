'use strict';

/**
 * The media upload allowlist must accept PKCS#12 keystores.
 *
 * `me.face_certificate` and `verifactu.certificate` are media fields, and both
 * e-invoicing paths consume the uploaded file as PKCS#12 and nothing else —
 * https.Agent({ pfx }), forge.pkcs12.pkcs12FromAsn1 and `openssl pkcs12`. v3 set
 * no upload restriction at all; the v5 port introduced a `security.allowedTypes`
 * allowlist that happened to omit the one format the app needs, so uploading a
 * .p12 in the admin failed with "File type 'application/x-pkcs12' is not
 * allowed" and neither feature could be configured.
 *
 * These run Strapi's own validator against the project's real config, so they
 * fail if either the allowlist or the upstream validation changes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Required by path: the package's `exports` map does not expose this internal.
const validation = require(
  path.join(__dirname, '..', 'node_modules', '@strapi', 'upload', 'dist', 'server', 'utils', 'mime-validation.js'),
);

function uploadSecurityConfig() {
  const env = (key, fallback) => fallback;
  env.int = (key, fallback) => fallback;
  env.bool = (key, fallback) => fallback;
  return require('../config/plugins.js')({ env }).upload.config.security;
}

// Content sniffing must actually run for these assertions to mean anything. The
// upload plugin dynamically imports the ESM-only `file-type`, which needs
// --experimental-vm-modules inside jest — package.json's test scripts set it. If
// it is ever dropped, detection degrades to "trust the declared type" and the
// renamed-executable case below fails loudly rather than passing silently.
const strapiStub = {
  log: {
    warn(message) {
      throw new Error(`MIME detection did not run: ${message}`);
    },
  },
};

/** Writes a temp file and validates it the way the upload plugin would. */
async function validate({ name, mimetype, bytes }, config) {
  const file = path.join(os.tmpdir(), `upload-test-${Date.now()}-${name}`);
  fs.writeFileSync(file, bytes);
  try {
    return await validation.validateFile({ originalFilename: name, filepath: file, mimetype }, config, strapiStub);
  } finally {
    fs.unlinkSync(file);
  }
}

// A PKCS#12 file is DER, so it opens with a SEQUENCE tag.
const DER_KEYSTORE = Buffer.concat([Buffer.from('30820', 'hex'), Buffer.alloc(256, 7)]);
// MZ — a Windows executable, renamed to look like a certificate.
const WINDOWS_EXE = Buffer.concat([Buffer.from('4d5a90000300000004000000ffff0000', 'hex'), Buffer.alloc(256)]);

describe('upload allowlist', () => {
  const config = uploadSecurityConfig();

  it('names the certificate types explicitly', () => {
    expect(config.allowedTypes).toEqual(expect.arrayContaining(['application/x-pkcs12']));
  });

  it('accepts a .p12 keystore', async () => {
    const result = await validate(
      { name: 'certificate.p12', mimetype: 'application/x-pkcs12', bytes: DER_KEYSTORE },
      config,
    );
    expect(result.isValid).toBe(true);
  });

  it('accepts a .pfx keystore — the same format under the other extension', async () => {
    const result = await validate(
      { name: 'certificate.pfx', mimetype: 'application/x-pkcs12', bytes: DER_KEYSTORE },
      config,
    );
    expect(result.isValid).toBe(true);
  });

  it('would reject it without the certificate entries — the reported failure', async () => {
    const withoutCerts = {
      ...config,
      allowedTypes: config.allowedTypes.filter((t) => !t.includes('pkcs12')),
    };
    const result = await validate(
      { name: 'certificate.p12', mimetype: 'application/x-pkcs12', bytes: DER_KEYSTORE },
      withoutCerts,
    );
    expect(result.isValid).toBe(false);
    expect(result.error.message).toBe("File type 'application/x-pkcs12' is not allowed");
  });

  it('still refuses an executable renamed to .p12', async () => {
    // Widening the allowlist must not become a way in: the content is sniffed,
    // so the declared type and extension do not decide this on their own.
    const result = await validate(
      { name: 'payload.p12', mimetype: 'application/x-pkcs12', bytes: WINDOWS_EXE },
      config,
    );
    expect(result.isValid).toBe(false);
  });

  it('keeps the everyday types working', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(256)]);
    const result = await validate({ name: 'logo.png', mimetype: 'image/png', bytes: png }, config);
    expect(result.isValid).toBe(true);
  });
});
