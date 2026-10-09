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
 * Config (per instance):
 *   tenant           slug of the instance name (`me.name`, Configuració General),
 *                    e.g. "Fusteria La Serra, SCCL" -> "fusteria-la-serra-sccl". It must
 *                    match the tenant registered on the tickets site, so renaming
 *                    the instance means renaming the tenant there too.
 *   TICKETS_TENANT   optional override of that tenant name
 *   TICKETS_SSO_KEY  the tenant's API key (environment only, never in the DB)
 *   TICKETS_URL      default https://tiquets.esstrapis.org
 */
const crypto = require('crypto');

const DEFAULT_URL = 'https://tiquets.esstrapis.org';
const TTL_SECONDS = 120;

// Same rules as the tickets site's tenant names: [a-z0-9][a-z0-9_-]{1,62}.
function tenantSlug(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63).replace(/^-+|-+$/g, '');
}

function ticketsConfig(env = process.env, meName = '') {
  const tenant = (env.TICKETS_TENANT || '').trim() || tenantSlug(meName);
  const apiKey = (env.TICKETS_SSO_KEY || '').trim();
  if (tenant.length < 2 || !apiKey) return null;
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

module.exports = { tenantSlug, ticketsConfig, buildTicketsLoginUrl, TTL_SECONDS };
