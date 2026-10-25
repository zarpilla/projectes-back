'use strict';
/* global strapi */

/**
 * Startup script (issues/342): the front moved from https://<site>/stats/ to
 * the root of the site (https://<site>/). The links the API puts in e-mails,
 * order QR codes and quote PDFs are built from `front_url` (config and
 * Configuració general, «Adreça de l'aplicació») and the password-reset link
 * from the users-permissions `email_reset_password` setting; drop the "/stats"
 * they were saved with. Only a "/stats" right after the host is dropped: other
 * values (another path, typed by hand) are left alone and logged. Old links
 * keep working: the front's nginx redirects /stats/… to /….
 *
 * Deploy the site nginx and the front at the root before the API that runs this.
 */

const STATS_AT_HOST = /^(https?:\/\/[^/?#]+)\/stats(?:\/(?:#\/?)?|$)/i;

/** "https://x/stats/" → "https://x/"; "https://x/stats/reset-password" → "https://x/reset-password". */
function atRoot(url) {
  if (typeof url !== 'string') return url;
  return url.trim().replace(STATS_AT_HOST, '$1/');
}

const FRONT_URL_TYPES = ['api::config.config', 'api::me.me'];
const STORE = { type: 'plugin', name: 'users-permissions' };

async function frontUrlsAtRoot() {
  for (const uid of FRONT_URL_TYPES) {
    const rows = await strapi.db.query(uid).findMany({ select: ['id', 'front_url'] });
    for (const row of rows) {
      if (!row.front_url) continue;
      const front_url = atRoot(row.front_url);
      if (front_url === row.front_url) {
        strapi.log.info(`[frontUrlsAtRoot] ${uid} #${row.id}: left as is: ${row.front_url}`);
        continue;
      }
      await strapi.db.query(uid).update({ where: { id: row.id }, data: { front_url } });
      strapi.log.info(`[frontUrlsAtRoot] ${uid} #${row.id}: ${row.front_url} → ${front_url}`);
    }
  }

  const store = strapi.store(STORE);
  const advanced = await store.get({ key: 'advanced' });
  if (advanced && advanced.email_reset_password) {
    const email_reset_password = atRoot(advanced.email_reset_password);
    if (email_reset_password !== advanced.email_reset_password) {
      await store.set({ key: 'advanced', value: { ...advanced, email_reset_password } });
      strapi.log.info(`[frontUrlsAtRoot] email_reset_password → ${email_reset_password}`);
    }
  }
}

module.exports = { frontUrlsAtRoot, atRoot };
