'use strict';

/**
 * Builds the html + text bodies of an email from a user-editable template
 * (me.invoice_template).
 *
 * Tenants write that template either as HTML (`<p>Bon dia {contact_name},</p>`)
 * or as plain text with line breaks. It used to go out only as `text`, and the
 * nodemailer provider copies `text` into `html` — so the plain-text alternative
 * carried the raw `<p>` tags, and every client that shows that part (plain-text
 * mode, some Outlook/Windows viewers) showed the tags to the customer.
 *
 * Now each part gets the right content: the HTML template as `html` and a
 * tag-free rendering of it as `text`; a plain-text template as `text` and an
 * escaped, line-broken copy as `html`.
 */

const HTML_TAG = /<\/?[a-z][\s\S]*?>/i;

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });

const htmlToText = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      // The template's own line breaks are source formatting, not content:
      // collapse whitespace inside each block, keep the block breaks above.
      .split(/\n{2,}/)
      .map((block) =>
        block
          .split('\n')
          .map((line) => line.replace(/[ \t\r]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n'),
      )
      .filter(Boolean)
      .join('\n\n'),
  ).trim();

const textToHtml = (text) =>
  text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');

/**
 * @param {string} template  the user's template, HTML or plain text
 * @param {object} values    placeholder -> value, e.g. { invoice_code: '2026-230' }
 *                           replaces every `{placeholder}` occurrence
 * @returns {{ html: string, text: string }}
 */
const buildEmailBody = (template, values = {}) => {
  const source = template || '';
  const isHtml = HTML_TAG.test(source);
  const fill = (escape) =>
    Object.entries(values).reduce(
      (body, [key, value]) => body.split(`{${key}}`).join(escape(value ?? '')),
      source,
    );

  if (isHtml) {
    const html = fill(escapeHtml);
    return { html, text: htmlToText(html) };
  }
  const text = fill(String).trim();
  return { html: textToHtml(text), text };
};

/**
 * Gives an outgoing email a real html part and a tag-free text part, whatever
 * the caller passed: `text` holding HTML (invoice template, users-permissions'
 * own reset/confirmation emails), `html` alone (task, incidence and contact-form
 * notifications), or plain `text` alone. The provider would otherwise copy one
 * into the other, leaving raw tags in the text/plain alternative.
 */
const normalizeEmailBody = (options) => {
  const { text, html } = options;
  if (!text && !html) return options;
  const textIsHtml = !!text && HTML_TAG.test(text);
  const htmlBody = html || (textIsHtml ? text : textToHtml(text));
  const textBody = text && !textIsHtml ? text : htmlToText(htmlBody);
  return { ...options, html: htmlBody, text: textBody };
};

/**
 * Routes every send of the email plugin's provider through normalizeEmailBody.
 * Runs from the app bootstrap, after the email plugin has created its provider.
 */
const wrapEmailProvider = (strapiInstance) => {
  const provider = strapiInstance.plugin('email')?.provider;
  if (!provider || provider.normalizesBody) return;
  const send = provider.send.bind(provider);
  provider.send = (options) => send(normalizeEmailBody(options));
  provider.normalizesBody = true;
};

module.exports = { buildEmailBody, htmlToText, normalizeEmailBody, wrapEmailProvider };
