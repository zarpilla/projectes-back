'use strict';
/* global strapi */

/**
 * Startup check (issues/021): make sure the password-reset e-mail has a link.
 *
 * Strapi 5 builds the link of the "forgot password" e-mail from the
 * users-permissions advanced setting `email_reset_password` (v3 took it from
 * the request, which Strapi 5 refuses). Tenants migrated by the ETL don't have
 * it, so it is filled here when empty, from RESET_PASSWORD_URL or else from the
 * server URL plus the front's path (/stats/, as served behind the same host).
 * A value set by hand is never overwritten. Cheap and idempotent: runs on
 * every boot, so setting the env var later is enough.
 */

const STORE = { type: 'plugin', name: 'users-permissions' };
const FRONT_RESET_PATH = '/stats/#/reset-password';

function resetPasswordUrl() {
  if (process.env.RESET_PASSWORD_URL) return process.env.RESET_PASSWORD_URL;
  const serverUrl = String(strapi.config.get('server.url') || '').replace(/\/+$/, '');
  return /^https?:\/\//.test(serverUrl) ? serverUrl + FRONT_RESET_PATH : null;
}

async function ensureResetPasswordUrl() {
  const store = strapi.store(STORE);
  const advanced = (await store.get({ key: 'advanced' })) || {};
  if (advanced.email_reset_password) return;

  const url = resetPasswordUrl();
  if (!url) {
    strapi.log.warn('[ensureResetPasswordUrl] no RESET_PASSWORD_URL nor server URL: password-reset e-mails will have no link');
    return;
  }
  await store.set({ key: 'advanced', value: { ...advanced, email_reset_password: url } });
  strapi.log.info(`[ensureResetPasswordUrl] email_reset_password set to ${url}`);
}

module.exports = { ensureResetPasswordUrl };
