'use strict';

/**
 * Refuses to serve private key material over HTTP.
 *
 * Uploads live under `public/`, which `strapi::public` (and nginx in
 * production) serves statically to anyone. That made the AEAT/FACe PKCS#12
 * certificate downloadable with no authentication at
 * /uploads/<name>.p12 — and its URL is handed to any authenticated caller by
 * GET /api/verifactu, since the media relation carries it.
 *
 * Nothing in the app needs these over HTTP: the certificate is read from disk
 * (path.join(strapi.dirs.static.public, url)), never fetched. The only thing
 * lost is downloading it again from the admin media library.
 *
 * This must be registered BEFORE `strapi::public` in config/middlewares.js,
 * and mirrored in the nginx config for production, where nginx serves
 * public/uploads directly and never reaches Node.
 */

/** Extensions that can carry a private key or a full keystore. */
const KEY_MATERIAL = /\.(p12|pfx|pem|key|jks|p8|p7b|p7s|asc|gpg|der|crt|cer)$/i;

/** Only the upload tree — the rest of public/ is app assets. */
const UPLOADS = /^\/uploads\//i;

module.exports = (config, { strapi }) => async (ctx, next) => {
  const path = ctx.path || '';
  if (UPLOADS.test(path) && KEY_MATERIAL.test(path)) {
    strapi.log.warn(`[security] refused key-material request: ${path} (ip ${ctx.ip})`);
    // 404 rather than 403: do not confirm that the file is there.
    return ctx.notFound();
  }
  return next();
};
