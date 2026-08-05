'use strict';

/**
 * activity controller (v5). Ported from v3 api/activity/controllers/activity.js.
 * Custom endpoints: totalByDay, getForCalendar, importCalendar (Google/iCal sync),
 * move, importData (legacy backfill, now a no-op).
 *
 * Data-access migration: strapi.query -> strapi.db.query; sanitizeEntity removed.
 * The v3 Node<18 polyfills require is dropped (v5 requires Node 20).
 * The `scheduleRefresh` calls are stubbed until the totalsRefreshScheduler is
 * redesigned in P4.10 (the v3 in-process version is broken under PM2).
 */
const _ = require('lodash');
const moment = require('moment');
const ical = require('node-ical');
const { RRule } = require('rrule');
const { google } = require('googleapis');
const fs = require('fs');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery } = require('../../../services/query-adapter');

// TODO(P4.10): replace with the DB-backed totals-refresh scheduler.
const scheduleRefresh = () => {};

module.exports = createCoreController('api::activity.activity', ({ strapi }) => ({
  /**
   * GET /api/activities/calendar
   * Returns activities with slimmed-down user + project relations (for the calendar view).
   */
  async getForCalendar(ctx) {
    const opts = adaptQuery(ctx.query);
    const activities = await strapi.db.query('api::activity.activity').findMany({
      where: opts.filters || {},
      populate: { project: true, users_permissions_user: true },
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });

    return activities.map((entity) => {
      if (entity.users_permissions_user) {
        const { id, username, email, ical } = entity.users_permissions_user;
        entity.users_permissions_user = { id, username, email, ical };
      }
      if (entity.project) {
        // v3 defaulted empty arrays for these heavy relations; keep parity.
        entity.project.project_phases = entity.project.project_phases || [];
        entity.project.documents = entity.project.documents || [];
        entity.project.project_original_phases = entity.project.project_original_phases || [];
        const { project_phases, project_original_phases, documents, ...projectData } = entity.project;
        entity.project = projectData;
      }
      return entity;
    });
  },

  /**
   * GET /api/activities/total-by-day
   * Groups activities by date, summing hours (only for activities tied to a project).
   */
  async totalByDay(ctx) {
    const opts = adaptQuery(ctx.query);
    const activities = await strapi.db.query('api::activity.activity').findMany({
      where: opts.filters || {},
      populate: { project: { select: ['id'] } },
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });

    const byDay = activities.map((a) => ({
      hours: a.project && a.project.id ? a.hours : 0,
      date: a.date,
    }));

    return _(byDay)
      .groupBy('date')
      .map((rows, date) => ({ date, hours: _.sumBy(rows, 'hours') }))
      .value();
  },

  /**
   * GET /api/activities/import-calendar/:id
   * Imports calendar events for a user from Google Calendar (preferred) or iCal (fallback),
   * expanding recurring events within the requested date range. The v3 logic is preserved
   * verbatim; only the me/user data-access changed to Document Service / db.query.
   */
  async importCalendar(ctx) {
    const { id } = ctx.params;
    const { from, to } = ctx.query;

    const me = await strapi.documents('api::me.me').findFirst();
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id } });

    const fromDate = from ? moment(from) : moment().startOf('month');
    const toDate = to ? moment(to) : moment().endOf('month');

    if (from && !moment(from, 'YYYY-MM-DD', true).isValid()) {
      return ctx.badRequest('Invalid from date format. Use YYYY-MM-DD');
    }
    if (to && !moment(to, 'YYYY-MM-DD', true).isValid()) {
      return ctx.badRequest('Invalid to date format. Use YYYY-MM-DD');
    }

    const googleCredentials = me && me.google_credentials ? me.google_credentials : null;
    const allEvents = [];

    const fetchGoogleCalendarEvents = async (calendarId, userEmail) => {
      try {
        if (!googleCredentials || !googleCredentials.url) return [];
        const jsonPath = './public' + googleCredentials.url;
        if (!fs.existsSync(jsonPath)) {
          console.error('Google credentials file not found:', jsonPath);
          return [];
        }
        const credentials = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!credentials.client_email) {
          console.error('Invalid Google credentials file: missing client_email');
          return [];
        }

        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          clientOptions: { subject: userEmail },
        });
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.list({
          calendarId,
          timeMin: fromDate.toISOString(),
          timeMax: toDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });

        const events = response.data.items || [];
        const formatted = [];
        for (const event of events) {
          let hasDeclined = false;
          if (event.attendees) {
            for (const att of event.attendees) {
              if (att.email === userEmail) {
                hasDeclined = att.responseStatus === 'declined';
                break;
              }
            }
          }
          if (hasDeclined) continue;

          formatted.push({
            type: 'VEVENT',
            uid: event.id,
            summary: event.summary || '(No title)',
            description: event.description || '',
            start: event.start.dateTime ? new Date(event.start.dateTime) : new Date(event.start.date),
            end: event.end.dateTime ? new Date(event.end.dateTime) : new Date(event.end.date),
            location: event.location || '',
            organizer: event.organizer
              ? { params: { CN: event.organizer.email }, val: 'mailto:' + event.organizer.email }
              : null,
            attendee: event.attendees
              ? event.attendees.map((att) => ({
                  params: {
                    CN: att.email,
                    PARTSTAT:
                      att.responseStatus === 'accepted'
                        ? 'ACCEPTED'
                        : att.responseStatus === 'declined'
                          ? 'DECLINED'
                          : att.responseStatus === 'tentative'
                            ? 'TENTATIVE'
                            : 'NEEDS-ACTION',
                  },
                  val: 'mailto:' + att.email,
                }))
              : [],
            status: event.status ? event.status.toUpperCase() : 'CONFIRMED',
            created: event.created ? new Date(event.created) : null,
            lastmodified: event.updated ? new Date(event.updated) : null,
            url: event.htmlLink || '',
            isGoogleCalendar: true,
            isRecurring: !!event.recurrence,
          });
        }
        return formatted;
      } catch (error) {
        console.error('Error fetching Google Calendar events:', error);
        return [];
      }
    };

    const expandRecurringEvents = (event, from, to) => {
      const out = [];
      if (!event.rrule) {
        if (moment(event.start).isBetween(from, to, 'day', '[]')) out.push(event);
        return out;
      }
      try {
        const opts = RRule.parseString(event.rrule.toString());
        if (event.start) opts.dtstart = new Date(event.start);
        const rule = new RRule(opts);
        const occurrences = rule.between(from.toDate(), to.toDate(), true);
        const duration = moment(event.end).diff(moment(event.start));
        occurrences.forEach((occ) => {
          out.push({
            ...event,
            start: occ,
            end: new Date(occ.getTime() + duration),
            isRecurring: true,
            recurringDate: moment(occ).format('YYYY-MM-DD'),
          });
        });
      } catch (error) {
        console.error('Error parsing RRULE:', error);
        if (moment(event.start).isBetween(from, to, 'day', '[]')) out.push(event);
      }
      return out;
    };

    const useGoogleCalendar = googleCredentials && googleCredentials.url;

    if (user) {
      if (useGoogleCalendar && user.email) {
        try {
          allEvents.push(...(await fetchGoogleCalendarEvents(user.email, user.email)));
        } catch (error) {
          console.error('Error fetching user Google Calendar:', error);
        }
      } else if (user.ical && user.ical.startsWith('http')) {
        try {
          const resp = await ical.async.fromURL(user.ical);
          for (const k in resp) {
            if (resp[k].type !== 'VEVENT') continue;
            let hasDeclined = false;
            let userIsAttendee = false;
            if (resp[k].attendee) {
              const attendees = Array.isArray(resp[k].attendee) ? resp[k].attendee : [resp[k].attendee];
              for (const att of attendees) {
                if (att.params && att.params.CN === user.email) {
                  userIsAttendee = true;
                  hasDeclined = att.params.PARTSTAT === 'DECLINED';
                  break;
                }
              }
            }
            const hasAttendees = resp[k].attendee && resp[k].attendee.length > 0;
            const shouldInclude = hasAttendees ? userIsAttendee && !hasDeclined : true;
            if (shouldInclude) {
              allEvents.push(...expandRecurringEvents(resp[k], fromDate, toDate));
            }
          }
        } catch (error) {
          console.error('Error fetching user calendar:', error);
        }
      }
    }

    if (me && !useGoogleCalendar && me.ical && me.ical.startsWith('http')) {
      try {
        const resp = await ical.async.fromURL(me.ical);
        for (const k in resp) {
          if (resp[k].type !== 'VEVENT') continue;
          let isAttendee = false;
          let hasDeclined = false;
          if (resp[k].attendee) {
            const attendees = Array.isArray(resp[k].attendee) ? resp[k].attendee : [resp[k].attendee];
            for (const att of attendees) {
              if (att.params && att.params.CN === user.email) {
                isAttendee = true;
                hasDeclined = att.params.PARTSTAT === 'DECLINED';
                break;
              }
            }
          }
          if (isAttendee && !hasDeclined) {
            allEvents.push(...expandRecurringEvents(resp[k], fromDate, toDate));
          }
        }
      } catch (error) {
        console.error('Error fetching shared calendar:', error);
      }
    }

    allEvents.sort((a, b) => moment(a.start).diff(moment(b.start)));

    return {
      ical: allEvents,
      dateRange: { from: fromDate.format('YYYY-MM-DD'), to: toDate.format('YYYY-MM-DD') },
      totalEvents: allEvents.length,
    };
  },

  /**
   * POST /api/activities/move
   * Moves activities from one project to another within a date range.
   * The v3 `_internal` flag (lifecycle bypass) becomes a direct db.query update.
   */
  async move(ctx) {
    const { user, from, to, start, end } = ctx.request.body;
    if (to) {
      const where = { project: from, date: { $gte: start, $lte: end } };
      if (user) where.users_permissions_user = user;
      const activities = await strapi.db.query('api::activity.activity').findMany({
        where,
        limit: -1,
      });
      for (const a of activities) {
        // Direct db.update skips project beforeUpdate lifecycle (which reruns the
        // financial engine) — equivalent to v3's `_internal: true` flag.
        await strapi.db.query('api::activity.activity').update({
          where: { id: a.id },
          data: { project: to },
        });
      }
      scheduleRefresh(to);
      scheduleRefresh(from);
    }
    return { user, from, to, start, end };
  },

  /**
   * GET /api/activities/import
   * Legacy backfill (dedication -> activity migration). Commented out in v3; no-op here.
   * The actual migration is handled by the Phase 7 ETL.
   */
  async importData(ctx) {
    return { migrated: 0, note: 'Legacy dedication import is handled by the ETL (Phase 7)' };
  },
}));
