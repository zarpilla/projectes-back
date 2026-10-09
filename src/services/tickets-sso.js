'use strict';

/**
 * Login link to the tickets site (esstrapis-tickets) for the current user (issues/019).
 *
 * The tickets site accepts /sso?token=<token>. The token is
 * { tenant, tenantName, email, name, exp, nonce } encrypted with AES-256-GCM,
 * using a key derived (HKDF-SHA256) from TICKETS_SSO_KEY, a secret shared by all
 * instances and the tickets site. The secret never leaves the server. The tickets
 * site trusts any token that decrypts and registers new tenants on first use.
 * Tokens are single-use and short-lived (the tickets site accepts up to 10 min).
 *
 * Config (per instance):
 *   tenant           slug of the instance name (`me.name`, Configuració General),
 *                    e.g. "Fusteria La Serra, SCCL" -> "fusteria-la-serra-sccl"
 *   TICKETS_TENANT   optional override of that tenant name
 *   TICKETS_SSO_KEY  the shared secret (environment only, never in the DB)
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
  const secret = (env.TICKETS_SSO_KEY || '').trim();
  if (tenant.length < 2 || !secret) return null;
  return {
    tenant,
    tenantName: String(meName || '').trim() || tenant,
    secret,
    baseUrl: (env.TICKETS_URL || DEFAULT_URL).trim().replace(/\/+$/, ''),
  };
}

const AAD = Buffer.from('esstrapis-tickets-sso/v2', 'utf8');

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'esstrapis-tickets-sso', 'v2', 32));
}

function buildTicketsLoginUrl({ secret, tenant, tenantName, baseUrl = DEFAULT_URL, email, name, now = Date.now() }) {
  const payload = {
    tenant,
    tenantName,
    email,
    name,
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

module.exports = { tenantSlug, ticketsConfig, buildTicketsLoginUrl, TTL_SECONDS };
