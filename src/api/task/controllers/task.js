'use strict';
/* global strapi */

/**
 * task controller (v5). Ported from v3 api/task/controllers/task.js.
 * Custom endpoint: email — the daily task digest (cron 3am).
 *
 * Data-access migration: strapi.query -> strapi.db.query;
 * strapi.plugins['email'] -> strapi.plugin('email').
 */
const moment = require('moment');
const _ = require('lodash');
const { createCoreController } = require('@strapi/strapi').factories;

const sendEmail = async (data, config) => {
  if (!data) return;

  const emailFrom =
    strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';

  let text = '';
  let hasFinalWarnings = false;

  // Regular expired tasks (updated in the last 15 days)
  if (data.rows.filter((r) => r.type === 'expired' && !r.shouldStop).length > 0) {
    text += `Hi ha <a target='_blank' href='${config.front_url}tasks'>tasques o checklists</a> amb la data límit superada:<br><br>`;
    data.rows
      .filter((r) => r.type === 'expired' && !r.shouldStop)
      .forEach((r) => {
        text += ` - ${r.name}: ${moment(r.date, 'YYYY-MM-DD').format('DD/MM/YYYY')}<br>`;
      });
    text += '<br><br>';
  }

  // Final warning for tasks expired > 15 days without updates
  if (data.rows.filter((r) => r.type === 'expired' && r.shouldStop).length > 0) {
    hasFinalWarnings = true;
    text += `<strong>ÚLTIM AVÍS:</strong> Les següents tasques o checklists porten més de 15 dies amb la data límit superada i no s'han actualitzat. Deixareu de rebre notificacions sobre aquestes tasques:<br><br>`;
    data.rows
      .filter((r) => r.type === 'expired' && r.shouldStop)
      .forEach((r) => {
        text += ` - ${r.name}: ${moment(r.date, 'YYYY-MM-DD').format('DD/MM/YYYY')}<br>`;
      });
    text += '<br><br>';
  }

  if (data.rows.filter((r) => r.type === 'new').length > 0) {
    text += `Hi ha canvis en <a target='_blank' href='${config.front_url}tasks'>tasques o checklists</a>:<br><br>`;
    data.rows
      .filter((r) => r.type === 'new')
      .forEach((r) => {
        text += ` - ${r.name}<br>`;
      });
    text += '<br><br>';
  }

  if (data.email === process.env.TASK_EMAIL_TO || process.env.TASK_EMAIL_TO === '*') {
    const subject = hasFinalWarnings
      ? '[ESSSTRAPIS] Resum de tasques - ÚLTIM AVÍS'
      : '[ESSSTRAPIS] Resum de tasques';

    await strapi.plugin('email').service('email').send({
      to: data.email,
      from: emailFrom,
      subject,
      html: text,
    });
  }
  return text;
};

module.exports = createCoreController('api::task.task', ({ strapi }) => ({
  /**
   * GET /api/tasks/email
   * Builds and sends the per-user task digest email. Called by the 3am cron.
   */
  async email(ctx) {
    const messages = [];
    const fifteenDaysAgo = moment().subtract(15, 'days');

    const tasks = await strapi.db.query('api::task.task').findMany({
      where: { task_state: { $ne: 3 }, archived: false },
      populate: {
        users_permissions_users: true,
        project: true,
        checklist: { populate: { user: true, created: true } },
        created: true,
      },
      limit: -1,
    });

    const expired = tasks.filter((t) => t.due_date <= moment().format('YYYY-MM-DD'));

    // Process expired tasks
    expired.forEach((e) => {
      (e.users_permissions_users || []).forEach((u) => {
        const wasRecentlyUpdated = moment(e.updated_at).isAfter(fifteenDaysAgo);
        messages.push({
          id: e.id,
          name: e.name,
          project: e.project ? e.project.name : '',
          username: u.username,
          email: u.email,
          type: 'expired',
          scope: 'task',
          date: e.due_date,
          shouldStop: !wasRecentlyUpdated,
        });
      });
    });

    // Process checklists with overdue items
    const checklists = tasks.filter(
      (t) =>
        t.checklist &&
        t.checklist.length &&
        t.checklist.find(
          (c) => c.done === false && c.due_date && c.due_date <= moment().format('YYYY-MM-DD'),
        ),
    );

    checklists.forEach((e) => {
      const wasRecentlyUpdated = moment(e.updated_at).isAfter(fifteenDaysAgo);

      (e.users_permissions_users || []).forEach((u) => {
        messages.push({
          id: e.id,
          name: e.name,
          project: e.project ? e.project.name : '',
          username: u.username,
          email: u.email,
          type: 'expired',
          scope: 'task-checklist',
          date: e.due_date,
          shouldStop: !wasRecentlyUpdated,
        });
      });

      e.checklist.forEach((c) => {
        if (c.done === false && c.due_date <= moment().format('YYYY-MM-DD')) {
          messages.push({
            id: e.id,
            name: e.name,
            project: e.project ? e.project.name : '',
            username: c.user ? c.user.username : '',
            email: c.user ? c.user.email : '',
            type: 'expired',
            scope: 'checklist',
            date: c.due_date,
            shouldStop: !wasRecentlyUpdated,
          });
        }
      });
    });

    // New tasks (updated in the last day, notifying other users)
    const onedayBefore = moment().add(-1, 'days');
    const newTasks = tasks.filter((t) => moment(t.updated_at).isAfter(onedayBefore));

    newTasks.forEach((e) => {
      (e.users_permissions_users || []).forEach((u) => {
        if (e.created && e.created.username && u.username !== e.created.username) {
          messages.push({
            id: e.id,
            name: e.name,
            project: e.project ? e.project.name : '',
            username: u.username,
            email: u.email,
            type: 'new',
            scope: 'task',
            date: e.due_date,
            shouldStop: false,
          });
        }
      });
    });

    const newChecklists = tasks.filter(
      (t) =>
        t.checklist &&
        t.checklist.length &&
        t.checklist.find(
          (c) =>
            c.done === false &&
            moment(c.created_date).isAfter(onedayBefore) &&
            c.created &&
            c.created.username &&
            c.user &&
            c.user.username &&
            c.created.username !== c.user.username,
        ),
    );

    newChecklists.forEach((e) => {
      e.checklist.forEach((c) => {
        if (
          c.done === false &&
          moment(c.created_date).isAfter(onedayBefore) &&
          c.created &&
          c.created.username &&
          c.user &&
          c.user.username &&
          c.created.username !== c.user.username
        ) {
          messages.push({
            id: e.id,
            name: e.name,
            project: e.project ? e.project.name : '',
            username: c.user.username,
            email: c.user.email,
            type: 'new',
            scope: 'checklist',
            date: c.due_date,
            shouldStop: false,
          });
        }
      });
    });

    const emails = _(messages)
      .groupBy('email')
      .map((rows, email) => ({ email, rows: _.uniqBy(rows, 'id') }))
      .value();

    const config = await strapi.documents('api::config.config').findFirst();

    const sentEmails = [];
    if (emails.length) {
      for (const email of emails) {
        const msg = await sendEmail(email, config);
        sentEmails.push(msg);
      }
    }

    return { expired, checklists, messages, newTasks, newChecklists, emails, sentEmails };
  },
}));
