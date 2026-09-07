'use strict';

/**
 * Secrets the app has to USE must not be declared `type: "password"`.
 *
 * Strapi 5's document service bcrypt-hashes every attribute of that type on
 * write, unconditionally:
 *
 *   // @strapi/core/dist/services/document-service/attributes/transforms.js
 *   password(value, context) { ... return bcrypt.hashSync(value.toString(), rounds); }
 *
 * Strapi 3 had no such transform for content-type attributes, so the same
 * schema stored plaintext in v3 and a hash in v5. Everything here is a value
 * that must come back out intact — a PKCS#12 passphrase handed to
 * https.Agent({ passphrase }) / openssl, or an API key sent as X-API-Key. A
 * hash makes VeriFactu fail with "mac verify failure" and the DIR3 and
 * invoice-parser integrations fail with 401.
 *
 * `private: true` keeps them out of API responses, which is the protection
 * `password` was providing.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** Every content-type and component schema in the project. */
function schemas() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'schema.json' || (dir.includes('components') && entry.name.endsWith('.json'))) {
        found.push(full);
      }
    }
  };
  walk(path.join(SRC, 'api'));
  const components = path.join(SRC, 'components');
  if (fs.existsSync(components)) walk(components);
  return found;
}

const SECRETS = [
  ['verifactu', 'certificate_password'],
  ['me', 'face_certificate_password'],
  ['me', 'certificate_pwd'],
  ['me', 'dir3_api_token'],
  ['me', 'invoice_parser_api_token'],
];

describe('secret fields', () => {
  it('are never declared as password, anywhere', () => {
    const hashed = [];
    for (const file of schemas()) {
      const attributes = JSON.parse(fs.readFileSync(file, 'utf8')).attributes || {};
      for (const [name, def] of Object.entries(attributes)) {
        if (def && def.type === 'password') {
          hashed.push(`${path.relative(SRC, file)}:${name}`);
        }
      }
    }
    expect(hashed).toEqual([]);
  });

  it.each(SECRETS)('%s.%s is a private string, so it survives the write', (api, field) => {
    const file = path.join(SRC, 'api', api, 'content-types', api, 'schema.json');
    const def = JSON.parse(fs.readFileSync(file, 'utf8')).attributes[field];
    expect(def).toEqual({ type: 'string', private: true });
  });
});
