'use strict';
/* global strapi */

/**
 * Local Strapi v5 email provider for SendGrid (P8.4).
 *
 * Replaces v3's strapi-provider-email-sendgrid package (v3-only, unmaintained
 * for v5). Implements the standard Strapi email-provider contract:
 *   init(providerOptions, settings) -> { send(options) }
 * and sends through the SendGrid v3 REST API (same payload shape the old
 * provider used: personalizations + from + subject + text/html contents).
 *
 * options.send receives: { to, from, replyTo, subject, text, html }.
 */

const axios = require('axios');

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

const toEmailObjects = (value) => {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((e) => !!e)
    .map((e) => (typeof e === 'object' ? { email: e.email, name: e.name } : { email: e }));
};

module.exports = {
  init(providerOptions = {}, settings = {}) {
    const apiKey = providerOptions.apiKey;
    const defaultFrom = settings.defaultFrom || 'no-reply@example.com';
    const defaultReplyTo = settings.defaultReplyTo || defaultFrom;

    return {
      async send(options) {
        if (!apiKey) {
          throw new Error('SendGrid provider: SENDGRID_API_KEY is not configured');
        }

        const from = options.from || defaultFrom;
        const replyTo = options.replyTo || defaultReplyTo;

        const contents = [];
        if (options.text) {
          contents.push({ type: 'text/plain', value: options.text });
        }
        if (options.html) {
          contents.push({ type: 'text/html', value: options.html });
        }

        const payload = {
          personalizations: [{ to: toEmailObjects(options.to) }],
          from: toEmailObjects(from)[0],
          replyTo: toEmailObjects(replyTo)[0],
          subject: options.subject,
          content: contents.length ? contents : [{ type: 'text/plain', value: '' }],
        };

        if (Array.isArray(options.attachments) && options.attachments.length) {
          payload.attachments = options.attachments.map((a) => ({
            content: a.content,
            filename: a.filename,
            type: a.type,
            disposition: a.disposition,
          }));
        }

        try {
          await axios.post(SENDGRID_ENDPOINT, payload, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          });
        } catch (error) {
          const details = error.response?.data || error.message;
          strapi.log.error('[email-sendgrid] send failed:', details);
          throw new Error(`SendGrid send failed: ${JSON.stringify(details)}`, { cause: error });
        }
      },
    };
  },
};
