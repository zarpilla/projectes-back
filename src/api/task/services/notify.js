'use strict';
/* global strapi */

/**
 * Emails sent at once (the daily digest sums up the rest): a task assigned to
 * someone, and a mention in a task comment. Same gate as the digest
 * (services/email-gate.js): the entity's switch in Configuració general and
 * TASK_EMAIL_TO. Nobody is told about their own actions.
 */
const { taskEmailAllowed } = require('./email-gate');
const { getMe } = require('../../../services/me-settings');

const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** People added to a task by this save (not the one who saved it). */
function newlyAssigned(beforeUsers, afterUsers, actorId) {
  const before = new Set((beforeUsers || []).map((u) => u.id));
  return (afterUsers || []).filter((u) => !before.has(u.id) && u.id !== actorId && u.email);
}

function assignmentEmail(task, actor, frontUrl) {
  const who = actor ? actor.username : "Algú";
  const project = task.project && task.project.name ? ` (${task.project.name})` : '';
  const due = task.due_date ? `<br>Data límit: ${task.due_date.split('-').reverse().join('/')}` : '';
  return {
    subject: `[ESSTRAPIS] T'han assignat una tasca: ${task.name}`,
    html: `${escapeHtml(who)} t'ha assignat la tasca <b>${escapeHtml(task.name)}</b>${escapeHtml(project)}.${due}<br><br>` +
      `<a target="_blank" href="${frontUrl}tasks?task=${task.id}">Obre la tasca</a>`,
  };
}

function mentionEmail(task, comment, actor, frontUrl) {
  const who = actor ? actor.username : "Algú";
  return {
    subject: `[ESSTRAPIS] ${who} t'ha esmentat a «${task.name}»`,
    html: `${escapeHtml(who)} t'ha esmentat en un comentari de la tasca <b>${escapeHtml(task.name)}</b>:<br><br>` +
      `<blockquote>${escapeHtml(comment.text).replace(/\n/g, '<br>')}</blockquote>` +
      `<a target="_blank" href="${frontUrl}tasks?task=${task.id}">Obre la tasca</a>`,
  };
}

async function send(people, build) {
  if (!people.length) return [];
  const me = await getMe();
  const config = await strapi.documents('api::config.config').findFirst();
  const frontUrl = (config && config.front_url) || '';
  const from = strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
  const sent = [];
  for (const person of people) {
    if (!taskEmailAllowed(person.email, { me })) continue;
    const { subject, html } = build(frontUrl);
    try {
      await strapi.plugin('email').service('email').send({ to: person.email, from, subject, html });
      sent.push(person.email);
    } catch (error) {
      strapi.log.error(`task email to ${person.email}: ${error.message}`);
    }
  }
  return sent;
}

module.exports = {
  newlyAssigned,
  assignmentEmail,
  mentionEmail,
  notifyAssigned: (task, people, actor) => send(people, (url) => assignmentEmail(task, actor, url)),
  notifyMentioned: (task, comment, people, actor) => send(people, (url) => mentionEmail(task, comment, actor, url)),
};
