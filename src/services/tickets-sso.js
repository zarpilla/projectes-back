'use strict';

/**
 * Login link to the tickets site (esstrapis-tickets) for the current user (issues/019).
 *
 * The tickets site accepts /sso?tenant=<tenant>&token=<token>. The token is
 * { email, name, exp, nonce } encrypted with AES-256-GCM, using a key derived
 * (HKDF-SHA256) from this instance's API key and the tenant name, with the
 * tenant as additional authenticated data. The API key never leaves the server.
 * Tokens are single-use and short-lived (the tickets site accepts up to 10 min).
 *
 * Config (per instance, environment):
 *   TICKETS_TENANT   tenant name registered on the tickets site
 *   TICKETS_SSO_KEY  that tenant's API key
 *   TICKETS_URL      default https://tiquets.esstrapis.org
 */
const crypto = require('crypto');

const DEFAULT_URL = 'https://tiquets.esstrapis.org';
const TTL_SECONDS = 120;

function ticketsConfig(env = process.env) {
  const tenant = (env.TICKETS_TENANT || '').trim();
  const apiKey = (env.TICKETS_SSO_KEY || '').trim();
  if (!tenant || !apiKey) return null;
  return { tenant, apiKey, baseUrl: (env.TICKETS_URL || DEFAULT_URL).trim().replace(/\/+$/, '') };
}

function deriveKey(apiKey, tenant) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey, 'utf8'), 'esstrapis-tickets-sso', tenant, 32));
}

function buildTicketsLoginUrl({ tenant, apiKey, baseUrl = DEFAULT_URL, email, name, now = Date.now() }) {
  const payload = {
    email,
    name,
    exp: Math.floor(now / 1000) + TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url'),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(apiKey, tenant), iv);
  cipher.setAAD(Buffer.from(tenant, 'utf8'));
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64url');
  return `${baseUrl}/sso?tenant=${encodeURIComponent(tenant)}&token=${token}`;
}

module.exports = { ticketsConfig, buildTicketsLoginUrl, TTL_SECONDS };
