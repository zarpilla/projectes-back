'use strict';
/* global strapi */
const { getMe } = require('../../../../services/me-settings');

/**
 * form-submission lifecycles (v5). Ported from v3 api/form-submission/models/form-submission.js.
 * Sends the contact-form notification email on submission.
 */
module.exports = {
  async beforeCreate(event) {
    const data = event.data;

    const me = await getMe();
    if (!me.contact_form_email) {
      throw new Error('contact_form_email not set');
    }

    const to = [data.email];
    me.contact_form_email.split(',').forEach((email) => to.push(email));
    const from =
      strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
    const subject = '[ESSSTRAPIS] Contacte a través del formulari';
    const userData = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { id: data.user } });

    const html = `
            <b>Contacte a través del formulari</b><br><br>
            PROVEÏDORA: ${userData.fullname || userData.username} (${userData.id})<br>
            CORREU: ${data.email} <br>
            NOM: ${data.name} <br>
            MISSATGE: ${data.message} <br><br>
            --<br>
            Missatge automàtic. Gràcies per contactar amb nosaltres.<br>
            ${me.name}<br>
            --<br>`;

    await strapi.plugin('email').service('email').send({ to, from, subject, html });
  },
};
