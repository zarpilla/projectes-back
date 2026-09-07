'use strict';

/**
 * Reversible encryption for the secrets the app has to replay verbatim.
 *
 * These are certificate passphrases and API keys — values that must come back
 * out intact to be handed to OpenSSL or sent as an X-API-Key header. Hashing
 * them is not an option (Strapi's `password` type bcrypts, which is what broke
 * VeriFactu with "mac verify failure"), so they are encrypted at rest instead:
 * ciphertext in the column, plaintext only in memory at the point of use.
 *
 * This protects database dumps and backups, which is the realistic leak path.
 * It does NOT protect against someone who can read the filesystem — the key
 * lives in the environment, next to the app. Moving the secrets out of the
 * database entirely (env vars) is stronger; this trades some of that for
 * keeping them manageable from the admin UI.
 *
 * Format: `enc:v1:<base64(iv | authTag | ciphertext)>`, AES-256-GCM with a
 * random 12-byte IV per value. The prefix makes encryption idempotent and lets
 * values migrated from v3 stay readable until they are next saved.
 *
 * Key: SECRETS_KEY (32 bytes, hex or base64). If unset it is derived from
 * APP_KEYS so an existing deployment keeps working without new configuration —
 * but APP_KEYS then become load-bearing, and rotating them makes every stored
 * secret undecryptable. Set SECRETS_KEY explicitly in production.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey;
let warnedAboutDerivedKey = false;

function parseKeyMaterial(raw) {
  if (!raw) return null;
  const hex = /^[0-9a-f]{64}$/i;
  const buffer = hex.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buffer.length === 32 ? buffer : null;
}

/** The AES key: SECRETS_KEY when set, otherwise derived from APP_KEYS. */
function key() {
  if (cachedKey) return cachedKey;

  const explicit = parseKeyMaterial(process.env.SECRETS_KEY);
  if (explicit) {
    cachedKey = explicit;
    return cachedKey;
  }
  if (process.env.SECRETS_KEY) {
    throw new Error('SECRETS_KEY must be 32 bytes, hex- or base64-encoded');
  }

  const appKeys = process.env.APP_KEYS;
  if (!appKeys) {
    throw new Error('Cannot encrypt secrets: set SECRETS_KEY (32 bytes, hex or base64)');
  }
  if (!warnedAboutDerivedKey) {
    warnedAboutDerivedKey = true;
    const log = (global.strapi && global.strapi.log) || console;
    log.warn(
      '[secret-crypto] SECRETS_KEY is not set; deriving the key from APP_KEYS. ' +
        'Rotating APP_KEYS will make stored secrets unreadable — set SECRETS_KEY explicitly.',
    );
  }
  cachedKey = crypto.createHash('sha256').update(appKeys).digest();
  return cachedKey;
}

/** True for a value this module produced. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypts a secret. Already-encrypted values and empty ones pass through, so
 * this is safe to run on every write.
 */
function encryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  if (isEncrypted(value)) return value;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Returns the usable secret.
 *
 * A value without the prefix is returned unchanged: rows migrated from v3 hold
 * plaintext and must keep working until they are next saved.
 */
function decryptSecret(value) {
  if (!isEncrypted(value)) return value;

  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(
      'Cannot decrypt stored secret — was SECRETS_KEY (or APP_KEYS, if the key is derived) changed? ' +
        'The value has to be entered again.',
    );
  }
}

/** The secret fields, by content type, that get encrypted on write. */
const SECRET_FIELDS = {
  'api::verifactu.verifactu': ['certificate_password'],
  'api::me.me': [
    'face_certificate_password',
    'certificate_pwd',
    'dir3_api_token',
    'invoice_parser_api_token',
  ],
};

/** Encrypts every secret field present in a write payload, in place. */
function encryptSecretFields(data, uid) {
  const fields = SECRET_FIELDS[uid];
  if (!data || !fields) return data;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      data[field] = encryptSecret(data[field]);
    }
  }
  return data;
}

/** Cleared between tests so a changed key is picked up. */
function resetKeyCache() {
  cachedKey = undefined;
  warnedAboutDerivedKey = false;
}

module.exports = {
  PREFIX,
  SECRET_FIELDS,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  encryptSecretFields,
  resetKeyCache,
};
