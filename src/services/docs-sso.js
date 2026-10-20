'use strict';

/**
 * Login link to the documentation site (esstrapis-docs) for the current user.
 *
 * Same scheme as the tickets site (services/tickets-sso.js): the docs site accepts
 * /sso?token=<token>, where the token is
 * { tenant, tenantName, email, name, roles, route?, exp, nonce } encrypted with
 * AES-256-GCM, using a key derived (HKDF-SHA256) from DOCS_SSO_KEY, a secret shared
 * by all instances and the docs site. The key derivation and the AAD differ from the
 * tickets ones, so a token for one site never works on the other. `roles` are the
 * user's app permissions (they decide which chapters she reads) and `route` is the
 * screen she was on, for contextual help.
 *
 * Config (per instance):
 *   tenant          same as the tickets site: TICKETS_TENANT, or the slug of `me.name`
 *   DOCS_SSO_KEY    the shared secret (environment only, never in the DB)
 *   DOCS_URL        default https://docs.esstrapis.org
 */
const crypto = require('crypto');
const { tenantSlug } = require('./tickets-sso');

const DEFAULT_URL = 'https://docs.esstrapis.org';
const TTL_SECONDS = 120;
const AAD = Buffer.from('esstrapis-docs-sso/v1', 'utf8');
const ROLE_RE = /^[a-z_]{2,32}$/;

function docsConfig(env = process.env, meName = '') {
  const tenant = (env.TICKETS_TENANT || '').trim() || tenantSlug(meName);
  const secret = (env.DOCS_SSO_KEY || '').trim();
  if (tenant.length < 2 || !secret) return null;
  return {
    tenant,
    tenantName: String(meName || '').trim() || tenant,
    secret,
    baseUrl: (env.DOCS_URL || DEFAULT_URL).trim().replace(/\/+$/, ''),
  };
}

// An app route ("/project/642"), or undefined when it isn't one.
function cleanRoute(route) {
  const r = String(route || '').trim();
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (!r.startsWith('/') || r.startsWith('//') || r.length > 300 || /[\u0000-\u001f\s]/.test(r)) return undefined;
  return r;
}

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'esstrapis-docs-sso', 'v1', 32));
}

function buildDocsLoginUrl({ secret, tenant, tenantName, baseUrl = DEFAULT_URL, email, name, roles = [], route, now = Date.now() }) {
  const payload = {
    tenant,
    tenantName,
    email,
    name,
    roles: [...new Set(roles)].filter((r) => ROLE_RE.test(r)),
    ...(cleanRoute(route) ? { route: cleanRoute(route) } : {}),
    exp: Math.floor(now / 1000) + TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url'),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64url');
  return `${baseUrl}/sso?token=${token}`;
}

module.exports = { docsConfig, buildDocsLoginUrl, cleanRoute, TTL_SECONDS };
