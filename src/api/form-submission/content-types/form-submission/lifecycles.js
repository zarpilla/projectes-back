'use strict';
/* global strapi */
const { getMe } = require('../../../../services/me-settings');
const { relationId } = require('../../../../services/relation-input');
const { escapeHtml } = require('../../../../services/email-body');

const splitEmails = (list) =>
  (list || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

/**
 * form-submission lifecycles (v5). Ported from v3 api/form-submission/models/form-submission.js.
 * Sends the contact-form notification email on submission.
 *
 * The mail goes after the message is saved (issues/167): it used to be sent in
 * beforeCreate, so a mail failure, or an empty contact_form_email, lost the
 * message and answered 500. A failure is logged; the message stays in
 * Administració › Missatges. It goes to the addresses of the configuration
 * and, as a copy, to the sender's own account; the `email` she typed is only
 * shown in the text, escaped like the rest.
 */
module.exports = {
  async afterCreate(event) {
    try {
      await sendSubmissionEmail(event.params.data || {});
    } catch (error) {
      strapi.log.error(
        `[form-submission] the mail of message ${event.result && event.result.id} failed: ${error.message}`,
      );
    }
  },
};

async function sendSubmissionEmail(data) {
  const me = await getMe();
  const office = splitEmails(me && me.contact_form_email);
  if (!office.length) {
    strapi.log.warn('[form-submission] contact_form_email not set: the message is saved but not mailed');
    return;
  }
  const userId = relationId(data.user);
  const userData =
    userId !== undefined && userId !== null
      ? await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: userId } })
      : null;

  const to = [...office, ...(userData && userData.email ? [userData.email] : [])];
  const from =
    strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
  const subject = '[ESSTRAPIS] Contacte a través del formulari';
  const sender = userData ? `${userData.fullname || userData.username} (${userData.id})` : '-';
  const text = (value) => escapeHtml(value === undefined || value === null ? '' : value);

  const html = `
            <b>Contacte a través del formulari</b><br><br>
            PROVEÏDORA: ${text(sender)}<br>
            CORREU: ${text(data.email)} <br>
            NOM: ${text(data.name)} <br>
            MISSATGE: ${text(data.message).replace(/\r?\n/g, '<br>')} <br><br>
            --<br>
            Missatge automàtic. Gràcies per contactar amb nosaltres.<br>
            ${text(me.name)}<br>
            --<br>`;

  await strapi.plugin('email').service('email').send({ to, from, subject, html });
}
