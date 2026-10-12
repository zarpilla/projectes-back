'use strict';
/* global strapi */

/**
 * Startup check (issues/021): make the users-permissions e-mails ours.
 *
 * Strapi seeds the "reset password" and "email confirmation" templates with
 * the sender `no-reply@strapi.io` and an English text, and the forgot-password
 * controller uses the template's sender instead of the email plugin's default.
 * The tenants' SMTP accounts only accept their own address as sender (553
 * "Sender address rejected: not owned by user"), so the e-mail was refused and
 * auth/forgot-password answered 500.
 *
 * Templates still carrying Strapi's sender get the one from EMAIL_FROM, or
 * else the SMTP account; those still carrying Strapi's text get the Catalan
 * one. Anything set by hand is never overwritten. Cheap and idempotent: runs
 * on every boot, so setting the env var later is enough.
 */

const STORE = { type: 'plugin', name: 'users-permissions' };
const STRAPI_SENDER = 'no-reply@strapi.io';
const DEFAULT_NAME = 'ESSTRAPIS';

// Strapi's subject and how its message starts, with our replacement.
const TEXTS = {
  reset_password: {
    strapiObject: 'Reset password',
    strapiMessage: '<p>We heard that you lost your password.',
    object: 'Canvi de la clau de pas',
    message: `<p>Hem rebut una petició per canviar la teva clau de pas.</p>

<p>Pots posar-ne una de nova amb aquest enllaç:</p>
<p><%= URL %>?code=<%= TOKEN %></p>

<p>Si no l'has demanat tu, no cal que facis res.</p>`,
  },
  email_confirmation: {
    strapiObject: 'Account confirmation',
    strapiMessage: '<p>Thank you for registering!</p>',
    object: 'Confirmació del compte',
    message: `<p>Gràcies per registrar-te!</p>

<p>Cal que confirmis la teva adreça de correu electrònic amb aquest enllaç:</p>

<p><%= URL %>?confirmation=<%= CODE %></p>`,
  },
};

// "Name <address>" or a bare address.
function parseSender(value) {
  const text = String(value || '').trim();
  const named = text.match(/^(.*)<([^<>\s]+@[^<>\s]+)>$/);
  if (named) {
    const name = named[1].trim().replace(/^"(.*)"$/, '$1');
    return { name: name || DEFAULT_NAME, email: named[2] };
  }
  return /^[^<>\s]+@[^<>\s]+$/.test(text) ? { name: DEFAULT_NAME, email: text } : null;
}

function sender() {
  return parseSender(process.env.EMAIL_FROM) || parseSender(process.env.SMTP_USER);
}

async function ensureAuthEmailTemplates() {
  const store = strapi.store(STORE);
  const templates = await store.get({ key: 'email' });
  if (!templates) return;

  const from = sender();
  const value = { ...templates };
  const changed = [];
  let staleSender = false;

  for (const key of Object.keys(templates)) {
    const options = templates[key] && templates[key].options;
    if (!options) continue;
    const fixed = { ...options };

    if (options.from && options.from.email === STRAPI_SENDER) {
      if (from) fixed.from = from;
      else staleSender = true;
    }
    const texts = TEXTS[key];
    if (texts && options.object === texts.strapiObject) fixed.object = texts.object;
    if (texts && String(options.message || '').startsWith(texts.strapiMessage)) fixed.message = texts.message;

    if (fixed.from !== options.from || fixed.object !== options.object || fixed.message !== options.message) {
      value[key] = { ...templates[key], options: fixed };
      changed.push(key);
    }
  }

  if (staleSender) {
    strapi.log.warn('[ensureAuthEmailTemplates] no EMAIL_FROM nor SMTP_USER address: password-reset e-mails keep the sender no-reply@strapi.io');
  }
  if (!changed.length) return;
  await store.set({ key: 'email', value });
  strapi.log.info(`[ensureAuthEmailTemplates] updated ${changed.join(', ')}${from ? ` (sender ${from.name} <${from.email}>)` : ''}`);
}

module.exports = { ensureAuthEmailTemplates };
