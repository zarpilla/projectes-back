'use strict';
/* global strapi */

/**
 * Task emails outside the daily digest: a task assigned to someone and a mention in a
 * task comment. They wait in a queue (task-notification rows) for a few minutes
 * (TASK_EMAIL_DELAY_MINUTES, 5 by default) and a cron sends them, so that:
 * - an assignment undone in the meantime, or a deleted comment, sends nothing (it is
 *   checked again when sending);
 * - several notices for the same person go out as one email.
 * Same gate as the digest (services/email-gate.js): the entity's switch in
 * Configuració general and TASK_EMAIL_TO. Nobody is told about their own actions.
 */
const { taskEmailAllowed } = require('./email-gate');
const { getMe } = require('../../../services/me-settings');

const UID = 'api::task-notification.task-notification';
const MAX_ATTEMPTS = 3;

const delayMs = () => {
  const minutes = Number(process.env.TASK_EMAIL_DELAY_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : 5) * 60 * 1000;
};

const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

/** People added to a task by this save (not the one who saved it). */
function newlyAssigned(beforeUsers, afterUsers, actorId) {
  const before = new Set((beforeUsers || []).map((u) => u.id));
  return (afterUsers || []).filter((u) => !before.has(u.id) && u.id !== actorId && u.email);
}

/** People taken off a task by this save. */
function removedFrom(beforeUsers, afterUsers) {
  const after = new Set((afterUsers || []).map((u) => u.id));
  return (beforeUsers || []).filter((u) => !after.has(u.id));
}

const taskLink = (task, frontUrl) => `<a target="_blank" href="${frontUrl}tasks?task=${task.id}">Obre la tasca</a>`;
const who = (actor) => escapeHtml(actor && actor.username ? actor.username : 'Algú');

function assignmentEmail(task, actor, frontUrl) {
  const project = task.project && task.project.name ? ` (${task.project.name})` : '';
  const due = task.due_date ? `<br>Data límit: ${task.due_date.split('-').reverse().join('/')}` : '';
  return {
    subject: `[ESSTRAPIS] T'han assignat una tasca: ${task.name}`,
    html: `${who(actor)} t'ha assignat la tasca <b>${escapeHtml(task.name)}</b>${escapeHtml(project)}.${due}<br><br>` +
      taskLink(task, frontUrl),
  };
}

function mentionEmail(task, comment, actor, frontUrl) {
  return {
    subject: `[ESSTRAPIS] ${actor && actor.username ? actor.username : 'Algú'} t'ha esmentat a «${task.name}»`,
    html: `${who(actor)} t'ha esmentat en un comentari de la tasca <b>${escapeHtml(task.name)}</b>:<br><br>` +
      `<blockquote>${escapeHtml(comment.text).replace(/\n/g, '<br>')}</blockquote>` +
      taskLink(task, frontUrl),
  };
}

/** One email for one person: the single-notice email, or a list when there are several. */
function noticesEmail(notices, frontUrl) {
  if (notices.length === 1) {
    const n = notices[0];
    return n.kind === 'mention'
      ? mentionEmail(n.task, n.comment, n.actor, frontUrl)
      : assignmentEmail(n.task, n.actor, frontUrl);
  }
  const items = notices.map((n) => {
    const name = `<b>${escapeHtml(n.task.name)}</b>`;
    const line = n.kind === 'mention'
      ? `${who(n.actor)} t'ha esmentat a ${name}: «${escapeHtml(n.comment.text)}»`
      : `${who(n.actor)} t'ha assignat ${name}${n.task.project && n.task.project.name ? ' (' + escapeHtml(n.task.project.name) + ')' : ''}`;
    return `<li>${line} · <a target="_blank" href="${frontUrl}tasks?task=${n.task.id}">obre-la</a></li>`;
  });
  return {
    subject: `[ESSTRAPIS] ${notices.length} novetats a les teves tasques`,
    html: `Novetats a les teves <a target="_blank" href="${frontUrl}tasks">tasques</a>:<ul>${items.join('')}</ul>`,
  };
}

/**
 * Whether a queued notice still makes sense when it is sent: the task is there and not
 * archived; for an assignment, the person is still on it; for a mention, the comment
 * still exists. Two notices of the same kind for the same task go out once.
 */
function stillValid(row) {
  if (!row.task || row.task.archived || !row.recipient || !row.recipient.email) return false;
  if (row.kind === 'assigned') {
    return (row.task.users_permissions_users || []).some((u) => u.id === row.recipient.id);
  }
  if (row.kind === 'mention') return !!row.comment;
  return false;
}

/** Valid notices grouped by recipient: [{ recipient, notices }]. */
function groupNotices(rows) {
  const byRecipient = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (!stillValid(row)) continue;
    const key = `${row.recipient.id}:${row.kind}:${row.task.id}:${row.kind === 'mention' ? row.comment.id : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byRecipient.has(row.recipient.id)) byRecipient.set(row.recipient.id, { recipient: row.recipient, notices: [] });
    byRecipient.get(row.recipient.id).notices.push(row);
  }
  return [...byRecipient.values()];
}

// ---------- queue

async function enqueue(kind, { task, comment = null, people, actor }) {
  const sendAfter = new Date(Date.now() + delayMs());
  for (const person of people) {
    await strapi.db.query(UID).create({
      data: {
        kind,
        recipient: person.id,
        actor: actor ? actor.id : null,
        task: task.id,
        comment: comment ? comment.id : null,
        send_after: sendAfter,
        attempts: 0,
      },
    });
  }
}

/** Pending assignment notices of people taken off a task. */
async function dropAssigned(task, people) {
  const ids = people.map((p) => p.id);
  if (!ids.length) return;
  await strapi.db.query(UID).deleteMany({
    where: { kind: 'assigned', task: { id: task.id }, recipient: { id: { $in: ids } } },
  });
}

/** Sends the notices whose wait is over (cron, every minute). */
async function processQueue(now = new Date()) {
  const rows = await strapi.db.query(UID).findMany({
    where: { send_after: { $lte: now } },
    populate: {
      recipient: true,
      actor: true,
      comment: true,
      task: { populate: { project: true, users_permissions_users: true } },
    },
    orderBy: { id: 'asc' },
  });
  if (!rows.length) return { sent: 0, dropped: 0 };

  const groups = groupNotices(rows);
  const keep = new Set();
  let sent = 0;
  const me = await getMe();
  const config = await strapi.documents('api::config.config').findFirst();
  const frontUrl = (config && config.front_url) || '';
  const from = strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
  for (const { recipient, notices } of groups) {
    if (!taskEmailAllowed(recipient.email, { me })) continue;
    const { subject, html } = noticesEmail(notices, frontUrl);
    try {
      await strapi.plugin('email').service('email').send({ to: recipient.email, from, subject, html });
      sent++;
    } catch (error) {
      strapi.log.error(`task email to ${recipient.email}: ${error.message}`);
      // tried again on the next runs, a few times
      for (const n of notices) {
        if ((n.attempts || 0) + 1 < MAX_ATTEMPTS) {
          keep.add(n.id);
          await strapi.db.query(UID).update({ where: { id: n.id }, data: { attempts: (n.attempts || 0) + 1 } });
        }
      }
    }
  }
  const done = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (done.length) await strapi.db.query(UID).deleteMany({ where: { id: { $in: done } } });
  return { sent, dropped: rows.length - done.length };
}

module.exports = {
  newlyAssigned,
  removedFrom,
  assignmentEmail,
  mentionEmail,
  noticesEmail,
  stillValid,
  groupNotices,
  processQueue,
  dropAssigned,
  notifyAssigned: (task, people, actor) => (people.length ? enqueue('assigned', { task, people, actor }) : null),
  notifyMentioned: (task, comment, people, actor) => (people.length ? enqueue('mention', { task, comment, people, actor }) : null),
  idOf,
};
