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

module.exports = { getMe, ME_UID };
