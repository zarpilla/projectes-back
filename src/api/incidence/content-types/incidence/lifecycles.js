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

module.exports = {
  async afterCreate(event) {
    try {
      await sendIncidenceEmail(event.result, 'created');
    } catch (error) {
      console.error('Error sending incidence creation email:', error);
    }
  },
  async afterUpdate(event) {
    const currentUserId = updater.consumeCurrentUserId();
    try {
      await sendIncidenceEmail(event.result, 'updated', currentUserId);
    } catch (error) {
      console.error('Error sending incidence update email:', error);
    }
  },
};

async function sendIncidenceEmail(incidence, action, updaterId = null) {
  const fullIncidence = await strapi.db.query('api::incidence.incidence').findOne({
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
      incidence_response: true,
    },
  });

  if (!fullIncidence || !fullIncidence.order) {
    console.error('Incidence or order not found');
    return;
  }

  const me = await strapi.documents('api::me.me').findFirst();
  if (!me || !me.contact_form_email) {
    console.error('contact_form_email not set');
    return;
  }

  const config = await strapi.documents('api::config.config').findFirst();
  const frontUrl = config && config.front_url ? config.front_url : '';

  const order = fullIncidence.order;
  const orderOwner = order.owner;
  const from =
    strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';

  let recipients = [];
  if (action === 'created') {
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
  else if (fullIncidence.state === 'closed') actionLabel = 'tancada';

  const subject = `[${me.name || 'ESSSTRAPIS'}] Incidència ${actionLabel} - Comanda #${order.id}`;

  const stateLabels = { open: 'Oberta', wip: 'En Procés', closed: 'Tancada' };

  let deliveryPoint = '-';
  if (order.contact) {
    deliveryPoint = order.contact.trade_name || order.contact_trade_name || '-';
  }

  let responsesHtml = '';
  if (fullIncidence.incidence_response && fullIncidence.incidence_response.length > 0) {
    responsesHtml = '<br><b>Respostes:</b><br>';
    fullIncidence.incidence_response.forEach((response, index) => {
      responsesHtml += `<br>${index + 1}. ${response.text || 'Sense text'}<br>`;
      if (response.response_date) {
        responsesHtml += `Data: ${new Date(response.response_date).toLocaleString('ca-ES')}<br>`;
      }
    });
  }

  const html = `
    <b>Incidència ${action === 'created' ? 'Creada' : 'Actualitzada'}</b><br><br>
    <b>ID Incidència:</b> <a href="${frontUrl}incidences?id=${fullIncidence.id}" target="_blank">${fullIncidence.id}</a><br>
    <b>Comanda:</b> #${order.id}<br>
    <b>Propietari Comanda:</b> ${orderOwner ? orderOwner.fullname || orderOwner.username : 'N/A'} ${orderOwner && orderOwner.email ? `(${orderOwner.email})` : ''}<br>
    <b>Punt d'entrega:</b> ${deliveryPoint}<br>
    <b>Estat:</b> ${stateLabels[fullIncidence.state] || fullIncidence.state}<br>
    <b>Descripció:</b> ${fullIncidence.description || 'N/A'}<br>
    ${fullIncidence.created_user ? `<b>Creat per:</b> ${fullIncidence.created_user.fullname || fullIncidence.created_user.username}<br>` : ''}
    ${fullIncidence.closed_date ? `<b>Data Tancament:</b> ${new Date(fullIncidence.closed_date).toLocaleString('ca-ES')}<br>` : ''}
    ${fullIncidence.closed_user ? `<b>Tancat per:</b> ${fullIncidence.closed_user.fullname || fullIncidence.closed_user.username}<br>` : ''}
    ${responsesHtml}
    <br>--<br>
    Missatge automàtic. Gràcies per la vostra atenció.<br>
    ${me.name || 'ESSSTRAPIS'}<br>
    --<br>`;

  await strapi.plugin('email').service('email').send({ to: recipients, from, subject, html });
  console.log(`Incidence ${action} email sent to:`, recipients);
}
