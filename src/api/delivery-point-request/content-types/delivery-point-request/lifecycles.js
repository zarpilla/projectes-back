'use strict';
/* global strapi */
const { getMe, getFrontUrl } = require('../../../../services/me-settings');
const { relationId } = require('../../../../services/relation-input');
const { escapeHtml } = require('../../../../services/email-body');

/**
 * delivery-point-request lifecycles (issues/357). A new request is mailed to
 * the office, the address that also gets the incidences (contact_form_email,
 * «Correu que rep els missatges» in Configuració general), with a copy to the
 * member, so the office can answer by replying. The mail goes after the request
 * is saved: a failure is logged and the request stays on the list.
 * NOTE: v5 lifecycle modules may only export hook functions.
 */
module.exports = {
  async afterCreate(event) {
    try {
      await sendRequestEmail(event.result || {}, event.params.data || {});
    } catch (error) {
      strapi.log.error(`[delivery-point-request] the mail of request ${event.result && event.result.id} failed: ${error.message}`);
    }
  },
};

const splitEmails = (list) =>
  (list || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

async function sendRequestEmail(result, data) {
  const me = await getMe();
  const office = splitEmails(me && me.contact_form_email);
  if (!office.length) {
    strapi.log.warn('[delivery-point-request] contact_form_email not set: the request is saved but not mailed');
    return;
  }
  const userId = relationId(data.user);
  const member =
    userId !== undefined && userId !== null
      ? await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: userId } })
      : null;
  const to = [...office, ...(member && member.email ? [member.email] : [])];
  const from = strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
  const replyTo = member && member.email ? member.email : undefined;
  const text = (value) => escapeHtml(value === undefined || value === null ? '' : value).replace(/\r?\n/g, '<br>');
  const memberName = member ? member.fullname || member.username : '-';
  const frontUrl = await getFrontUrl();
  const row = (label, value) => `<b>${label}:</b> ${text(value) || '-'}<br>`;

  const subject = `[${me.name || 'ESSTRAPIS'}] Consulta de nou punt d'entrega - ${data.city || ''}`.trim();
  const html = `
    <b>Consulta i autorització de nou punt d'entrega</b><br><br>
    ${row('Sòcia', member ? `${memberName}${member.email ? ` (${member.email})` : ''}` : '-')}
    ${row('Nom comercial', data.trade_name)}
    ${row('Població', data.city)}
    ${row('Adreça', data.address)}
    ${row('Horari', data.schedule)}
    ${row('Pes estimat de la comanda', data.estimated_weight)}
    ${row('Notes', data.notes)}
    <br>Responeu aquest correu per contestar la sòcia. Un cop resposta, marqueu-la a
    <a href="${frontUrl}consulta-punt-entrega" target="_blank">Consulta i autorització nou punt d'entrega</a>
    (núm. ${result.id || '-'}).<br>
    <br>--<br>
    Missatge automàtic.<br>
    ${text(me.name || 'ESSTRAPIS')}<br>
    --<br>`;

  await strapi.plugin('email').service('email').send({ to, from, replyTo, subject, html });
}
