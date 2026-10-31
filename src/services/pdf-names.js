'use strict';

/**
 * The secret part of the generated PDFs' file names (issues/374).
 *
 * Generated PDFs are written under public/uploads and served without login, so
 * their name is the only thing that keeps them private. The delivery notes
 * were `orders-<order id>.pdf` and the invoices `…-H<md5(type-code-id)>`: both
 * computable by anyone. A delivery note is printed on demand and never stored,
 * so it gets a random name. An invoice or a quote keeps a stable name (its PDF
 * is regenerated in place, and the `pdf` field points to it), keyed with a
 * server secret.
 */
const crypto = require('crypto');

/** A random token: 32 hex characters. */
const randomToken = () => crypto.randomBytes(16).toString('hex');

function secret() {
  return process.env.PDF_NAME_SECRET || process.env.APP_KEYS || null;
}

/** A stable token for `parts` (32 hex characters), unguessable without the secret. */
function stableToken(...parts) {
  const key = secret();
  if (!key) return randomToken();
  return crypto.createHmac('sha256', key).update(parts.join('-')).digest('hex').slice(0, 32);
}

module.exports = { randomToken, stableToken };
