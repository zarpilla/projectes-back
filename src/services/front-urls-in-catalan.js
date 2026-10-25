'use strict';
/* global strapi */

/**
 * Startup script (issues/343): the front's URLs are in Catalan. The links the
 * API builds itself (task and incidence e-mails, order QR codes) already use
 * the new paths; the password-reset link comes from the users-permissions
 * `email_reset_password` setting, saved with the old «/reset-password»: point
 * it at «/canviar-clau». Any other value (typed by hand) is left alone. Old
 * links keep working: the front redirects every old path to the new one.
 */

const STORE = { type: 'plugin', name: 'users-permissions' };
const OLD_RESET = /\/reset-password\/?(?=$|[?#])/;

/** "https://x/reset-password" → "https://x/canviar-clau". */
function catalanResetUrl(url) {
  if (typeof url !== 'string') return url;
  return url.trim().replace(OLD_RESET, '/canviar-clau');
}

async function frontUrlsInCatalan() {
  const store = strapi.store(STORE);
  const advanced = await store.get({ key: 'advanced' });
  if (!advanced || !advanced.email_reset_password) return;
  const email_reset_password = catalanResetUrl(advanced.email_reset_password);
  if (email_reset_password === advanced.email_reset_password) return;
  await store.set({ key: 'advanced', value: { ...advanced, email_reset_password } });
  strapi.log.info(`[frontUrlsInCatalan] email_reset_password → ${email_reset_password}`);
}

module.exports = { frontUrlsInCatalan, catalanResetUrl };
