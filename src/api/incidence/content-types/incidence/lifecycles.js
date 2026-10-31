'use strict';
/* global strapi */

/**
 * incidence lifecycles (v5). Ported from v3 api/incidences/models/incidences.js.
 * Sends incidence created/updated/closed notification emails.
 *
 * v5 lifecycles have no access to ctx, so the current user id (needed to decide
 * recipients on update) is bridged via utils/updater (set by the controller's
 * update override). NOTE: v5 lifecycle modules may only export hook functions.
 */
const updater = require('../../utils/updater');
const { getMe, getFrontUrl } = require('../../../../services/me-settings');
// what members write goes into the office's mail as text, not HTML (issues/383)
const { escapeHtml: esc } = require('../../../../services/email-body');

const INCIDENCE = 'api::incidence.incidence';

module.exports = {
  async afterCreate(event) {
    try {
      await sendIncidenceEmail(event.result, 'created');
    } catch (error) {
      console.error('Error sending incidence creation email:', error);
    }
  },
  // How many replies the incidence had, to tell in afterUpdate whether this
  // update added one (issues/154).
  async beforeUpdate(event) {
    try {
      const where = event.params && event.params.where;
      if (!where) return;
      const before = await strapi.db
        .query(INCIDENCE)
        .findOne({ where, populate: { incidence_response: true } });
      if (before && event.state) {
        event.state.replyCount = (before.incidence_response || []).length;
      }
    } catch (error) {
      console.error('Error reading incidence replies before update:', error);
    }
  },
  async afterUpdate(event) {
    const currentUserId = updater.consumeCurrentUserId();
    const replyCount = event.state ? event.state.replyCount : undefined;
    try {
      await sendIncidenceEmail(event.result, 'updated', currentUserId, replyCount);
    } catch (error) {
      console.error('Error sending incidence update email:', error);
    }
  },
};

const splitEmails = (list) =>
  (list || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

/** The list without repeated addresses (case-insensitive), first spelling kept. */
function uniqueEmails(emails) {
  const seen = new Set();
  return emails.filter((e) => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Who hears about a new reply: the office (contact_form_email) and the
 * order's owner, except the reply's own author. Users with orders_admin are
 * not added: the office chooses who gets these e-mails in contact_form_email,
 * not through permissions (issues/154 had added them; 2026-10-27 removed).
 */
function replyRecipients(reply, updaterId, orderOwner, me) {
  const authorId = (reply && reply.user && (reply.user.id || reply.user)) || updaterId || null;
  const authorEmail = (reply && reply.user && reply.user.email) || null;
  const ownerIsAuthor =
    orderOwner &&
    ((authorId && String(orderOwner.id) === String(authorId)) ||
      (authorEmail && orderOwner.email && orderOwner.email.toLowerCase() === authorEmail.toLowerCase()));

  const emails = [
    ...splitEmails(me.contact_form_email),
    ...(orderOwner && orderOwner.email && !ownerIsAuthor ? [orderOwner.email] : []),
  ];
  const excluded = authorEmail ? authorEmail.toLowerCase() : null;
  return uniqueEmails(emails.filter((e) => e.toLowerCase() !== excluded));
}

async function sendIncidenceEmail(incidence, action, updaterId = null, replyCountBefore = undefined) {
  const fullIncidence = await strapi.db.query(INCIDENCE).findOne({
    where: { id: incidence.id },
    populate: {
      order: {
        populate: {
          owner: true,
          collection_point: true,
          contact: true,
          pickup: true,
          transfer_pickup_destination: true,
        },
      },
      created_user: true,
      closed_user: true,
      incidence_response: { populate: { user: true } },
    },
  });

  if (!fullIncidence || !fullIncidence.order) {
    console.error('Incidence or order not found');
    return;
  }

  const me = await getMe();
  if (!me || !me.contact_form_email) {
    console.error('contact_form_email not set');
    return;
  }

  const frontUrl = await getFrontUrl();

  const order = fullIncidence.order;
  const orderOwner = order.owner;
  const from =
    strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';

  const replies = fullIncidence.incidence_response || [];
  const replyAdded =
    action === 'updated' && typeof replyCountBefore === 'number' && replies.length > replyCountBefore;

  let recipients = [];
  if (replyAdded) {
    recipients = replyRecipients(replies[replies.length - 1], updaterId, orderOwner, me);
  } else if (action === 'created') {
    recipients = me.contact_form_email.split(',').map((e) => e.trim());
    if (orderOwner && orderOwner.email) recipients.push(orderOwner.email);
  } else if (action === 'updated') {
    if (updaterId && orderOwner && String(updaterId) === String(orderOwner.id)) {
      recipients = me.contact_form_email.split(',').map((e) => e.trim());
    } else if (orderOwner && orderOwner.email) {
      recipients = [orderOwner.email];
    }
  }

  if (recipients.length === 0) {
    console.log('No recipients for incidence email');
    return;
  }

  let actionLabel = 'actualitzada';
  if (action === 'created') actionLabel = 'creada';
  else if (replyAdded) actionLabel = 'amb una resposta nova';
  else if (fullIncidence.state === 'closed') actionLabel = 'tancada';

  const subject = `[${me.name || 'ESSTRAPIS'}] Incidència ${actionLabel} - Comanda #${order.id}`;

  const stateLabels = { open: 'Oberta', wip: 'En Procés', closed: 'Tancada' };

  let deliveryPoint = '-';
  if (order.contact) {
    deliveryPoint = order.contact.trade_name || order.contact_trade_name || '-';
  }

  let responsesHtml = '';
  if (fullIncidence.incidence_response && fullIncidence.incidence_response.length > 0) {
    responsesHtml = '<br><b>Respostes:</b><br>';
    fullIncidence.incidence_response.forEach((response, index) => {
      responsesHtml += `<br>${index + 1}. ${esc(response.text || 'Sense text')}<br>`;
      if (response.user && typeof response.user === 'object') {
        responsesHtml += `Per: ${esc(response.user.fullname || response.user.username)}<br>`;
      }
      if (response.response_date) {
        responsesHtml += `Data: ${new Date(response.response_date).toLocaleString('ca-ES')}<br>`;
      }
    });
  }

  const html = `
    <b>Incidència ${action === 'created' ? 'Creada' : replyAdded ? 'amb una resposta nova' : 'Actualitzada'}</b><br><br>
    <b>ID Incidència:</b> <a href="${frontUrl}incidencies?id=${fullIncidence.id}" target="_blank">${fullIncidence.id}</a><br>
    <b>Comanda:</b> #${order.id}<br>
    <b>Propietari Comanda:</b> ${orderOwner ? esc(orderOwner.fullname || orderOwner.username) : 'N/A'} ${orderOwner && orderOwner.email ? `(${esc(orderOwner.email)})` : ''}<br>
    <b>Punt d'entrega:</b> ${esc(deliveryPoint)}<br>
    <b>Estat:</b> ${esc(stateLabels[fullIncidence.state] || fullIncidence.state)}<br>
    <b>Descripció:</b> ${esc(fullIncidence.description || 'N/A')}<br>
    ${fullIncidence.created_user ? `<b>Creat per:</b> ${esc(fullIncidence.created_user.fullname || fullIncidence.created_user.username)}<br>` : ''}
    ${fullIncidence.closed_date ? `<b>Data Tancament:</b> ${new Date(fullIncidence.closed_date).toLocaleString('ca-ES')}<br>` : ''}
    ${fullIncidence.closed_user ? `<b>Tancat per:</b> ${esc(fullIncidence.closed_user.fullname || fullIncidence.closed_user.username)}<br>` : ''}
    ${responsesHtml}
    <br>--<br>
    Missatge automàtic. Gràcies per la vostra atenció.<br>
    ${esc(me.name || 'ESSTRAPIS')}<br>
    --<br>`;

  await strapi.plugin('email').service('email').send({ to: recipients, from, subject, html });
  console.log(`Incidence ${action} email sent to:`, recipients);
}
