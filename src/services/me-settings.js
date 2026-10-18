'use strict';
/* global strapi */

/**
 * Accessor for the `me` single type — the instance-wide settings record.
 *
 * Most of what `me` holds lives in components (`options`, `quotes`,
 * `orders_options`) or media/relations (logo, FACe certificate, the default
 * bank accounts), and the v5 Document Service returns NONE of those without an
 * explicit `populate`. Every ported call site did `findFirst()` with no
 * populate, so `me.options` was undefined everywhere: the deductible-VAT
 * percentage silently fell back to 100% instead of the configured value, and
 * `me.logo` / the certificates were never found.
 *
 * Go through here rather than calling `strapi.documents('api::me.me')` directly.
 */

const ME_UID = 'api::me.me';

/**
 * @param {string|object} [populate] populate spec; defaults to everything at the
 *   first level (components, media and relations), which is what v3 returned.
 * @returns {Promise<object|null>}
 */
function getMe(populate = '*') {
  return strapi.documents(ME_UID).findFirst({ populate });
}

/**
 * The front's address for the links the API sends (task and incidence e-mails,
 * order QR codes, quote links), ending in "/". Configuració general edits
 * `me.front_url`; the `config` single type, which only the Strapi admin could
 * edit, is the fallback for tenants that never filled it (issues/159).
 */
function frontUrlOf(me, config) {
  const url = String((me && me.front_url) || (config && config.front_url) || '').trim();
  return url && !url.endsWith('/') ? `${url}/` : url;
}

async function getFrontUrl() {
  const me = await strapi.documents(ME_UID).findFirst({ fields: ['front_url'] });
  const config = await strapi.documents('api::config.config').findFirst();
  return frontUrlOf(me, config);
}

/**
 * The integration tokens are private (never sent to the front): Configuració
 * general only learns whether each one is set, to show «Configurat» and let
 * an admin replace it (issues/159).
 */
const WRITE_ONLY_TOKENS = ['dir3_api_token', 'invoice_parser_api_token'];

async function tokenFlags() {
  const row = await strapi.db.query(ME_UID).findOne({ select: ['id', ...WRITE_ONLY_TOKENS] });
  return Object.fromEntries(WRITE_ONLY_TOKENS.map((key) => [`${key}_set`, !!(row && row[key])]));
}

module.exports = { getMe, ME_UID, frontUrlOf, getFrontUrl, tokenFlags, WRITE_ONLY_TOKENS };
