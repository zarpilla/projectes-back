'use strict';
/* global strapi */

/**
 * Startup script (issues/158): the front moved from hash URLs
 * (https://<site>/stats/#/tasks) to plain ones (https://<site>/stats/tasks).
 * The links the API puts in e-mails, order QR codes and quote PDFs are built
 * from `front_url` (config and Configuració general) and the password-reset
 * link from the users-permissions `email_reset_password` setting; drop the
 * "#/" they were saved with. Old links keep working: the front rewrites them.
 *
 * Deploy the front with plain URLs before the API that runs this: an older
 * front can't open a plain path.
 */

/** "https://x/stats/#/" → "https://x/stats/"; "https://x/stats/#/reset-password" → "https://x/stats/reset-password". */
function withoutHash(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/\/?#\//, '/');
}

const FRONT_URL_TYPES = ['api::config.config', 'api::me.me'];
const STORE = { type: 'plugin', name: 'users-permissions' };

async function frontUrlsWithoutHash() {
  for (const uid of FRONT_URL_TYPES) {
    const rows = await strapi.db.query(uid).findMany({ select: ['id', 'front_url'] });
    for (const row of rows) {
      const front_url = withoutHash(row.front_url);
      if (front_url === row.front_url) continue;
      await strapi.db.query(uid).update({ where: { id: row.id }, data: { front_url } });
      strapi.log.info(`[frontUrlsWithoutHash] ${uid} #${row.id}: ${row.front_url} → ${front_url}`);
    }
  }

  const store = strapi.store(STORE);
  const advanced = await store.get({ key: 'advanced' });
  if (advanced && advanced.email_reset_password) {
    const email_reset_password = withoutHash(advanced.email_reset_password);
    if (email_reset_password !== advanced.email_reset_password) {
      await store.set({ key: 'advanced', value: { ...advanced, email_reset_password } });
      strapi.log.info(`[frontUrlsWithoutHash] email_reset_password → ${email_reset_password}`);
    }
  }
}

module.exports = { frontUrlsWithoutHash, withoutHash };
