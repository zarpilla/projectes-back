'use strict';
/* global strapi */

/**
 * daily-dedication lifecycles (v5). Ported from v3 api/daily-dedication/models/daily-dedication.js.
 * Validates no overlapping dedication periods; back-propagates cost_by_hour to activities.
 */
const { relationId } = require('../../../../services/relation-input');
// A plain Error from a lifecycle surfaces as a bare 500 'Internal Server Error',
// so the rule that rejected the write never reaches the user. ApplicationError
// answers 400 with the message, which the views already display.
const { errors: { ApplicationError } } = require('@strapi/utils');

// A period ending before it starts, or with negative hours, was saved (201)
// and then counted in every hours screen (issues/225).
function refuseInvalid(data, current = {}) {
  const from = data.from !== undefined ? data.from : current.from;
  const to = data.to !== undefined ? data.to : current.to;
  const hours = data.hours !== undefined ? data.hours : current.hours;
  if (from && to && String(to) < String(from)) {
    throw new ApplicationError('daily-dedication ends before it starts');
  }
  if (hours !== null && hours !== undefined && hours !== '' && !(Number(hours) >= 0)) {
    throw new ApplicationError('daily-dedication hours must be 0 or more');
  }
}

module.exports = {
  async beforeCreate(event) {
    const data = event.params.data;
    refuseInvalid(data);
    const dedications = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findMany({ where: { users_permissions_user: relationId(data.users_permissions_user) } });

    const invalids = dedications.filter(
      (d) => (data.to >= d.from && data.to <= d.to) || (data.from <= d.to && data.to >= d.from),
    );
    if (invalids.length) {
      console.error('daily-dedication overlaps', invalids);
      throw new ApplicationError('daily-dedication overlaps');
    }
    await updateActivitiesPrice(data);
  },

  async beforeUpdate(event) {
    const data = event.params.data;
    const id = event.params.where.id;
    // a partial update keeps the saved dates/hours it does not send
    const needsCurrent = ['from', 'to', 'hours'].some((k) => data[k] === undefined);
    const current = needsCurrent
      ? await strapi.db.query('api::daily-dedication.daily-dedication').findOne({ where: { id } })
      : null;
    refuseInvalid(data, current || {});
    const dedications = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findMany({ where: { users_permissions_user: relationId(data.users_permissions_user) } });
    const others = dedications.filter((d) => String(d.id) !== String(id));

    const invalids = others.filter(
      (d) => (data.to >= d.from && data.to <= d.to) || (data.from <= d.to && data.to >= d.from),
    );
    if (invalids.length) {
      console.error('daily-dedication overlaps', invalids);
      throw new ApplicationError('daily-dedication overlaps');
    }
    await updateActivitiesPrice(data);
  },
};

// Back-propagate cost_by_hour to the user's activities in the date range.
async function updateActivitiesPrice(data) {
  const activities = await strapi.db.query('api::activity.activity').findMany({
    where: {
      // at lifecycle time this is a v5 relation operation ({ set: [{ id }] }),
      // not the raw id the v3 port assumed
      users_permissions_user: relationId(data.users_permissions_user),
      date: { $gte: data.from, $lte: data.to },
    },
  });
  for (const ap of activities) {
    if (ap.cost_by_hour !== data.costByHour && data.costByHour !== null) {
      await strapi.db
        .query('api::activity.activity')
        .update({ where: { id: ap.id }, data: { cost_by_hour: data.costByHour } });
    }
  }
}
