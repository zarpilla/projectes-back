'use strict';
/* global strapi */

/**
 * delivery-point-request service. The mail that tells the member the office's
 * decision on her request (issues/357, seguiment): approved or rejected, with the office's
 * message if it wrote one. It goes to the member, replies to the office (the
 * incidences' address, contact_form_email).
 */
const { createCoreService } = require('@strapi/strapi').factories;
const { getMe, getFrontUrl } = require('../../../services/me-settings');
const { escapeHtml } = require('../../../services/email-body');

const UID = 'api::delivery-point-request.delivery-point-request';

const splitEmails = (list) =>
  (list || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

const text = (value) =>
  escapeHtml(value === undefined || value === null ? '' : value).replace(/\r?\n/g, '<br>');

module.exports = createCoreService(UID, () => ({
  async sendDecisionEmail(id) {
    const request = await strapi.db.query(UID).findOne({ where: { id }, populate: { user: true } });
    if (!request || !request.status) return false;
    const member = request.user;
    if (!member || !member.email) {
      strapi.log.warn(`[delivery-point-request] request ${id} decided, but its member has no e-mail`);
      return false;
    }
    const me = (await getMe()) || {};
    const office = splitEmails(me.contact_form_email);
    const from = strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
    const approved = request.status === 'approved';
    const org = me.name || 'ESSTRAPIS';
    const point = [request.trade_name, request.address, request.city].filter(Boolean).join(', ');
    const frontUrl = await getFrontUrl();

    const subject = `[${org}] Consulta de nou punt d'entrega ${approved ? 'aprovada' : 'rebutjada'} - ${request.city || ''}`.trim();
    const html = `
    Hola,<br><br>
    La vostra consulta de nou punt d'entrega (${text(point) || '-'}) s'ha <b>${approved ? 'aprovat' : 'rebutjat'}</b>.<br>
    ${request.answer ? `<br>${text(request.answer)}<br>` : ''}
    ${approved ? "<br>L'oficina en donarà d'alta el punt d'entrega.<br>" : ''}
    <br>Podeu veure les vostres consultes a
    <a href="${frontUrl}consulta-punt-entrega" target="_blank">Consulta i autorització nou punt d'entrega</a>.<br>
    <br>--<br>
    Missatge automàtic.<br>
    ${text(org)}<br>
    --<br>`;

    await strapi.plugin('email').service('email').send({
      to: [member.email],
      from,
      replyTo: office.length ? office.join(', ') : undefined,
      subject,
      html,
    });
    return true;
  },
}));
