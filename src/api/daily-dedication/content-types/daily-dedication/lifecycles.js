'use strict';
/* global strapi */

/**
 * daily-dedication lifecycles (v5). Ported from v3 api/daily-dedication/models/daily-dedication.js.
 * Validates no overlapping dedication periods; back-propagates cost_by_hour to activities.
 * The API computes costByHour from the salary and «Anys» on every save, and a
 * period change re-prices the person's planning lines (issues/416).
 */
const { relationId } = require('../../../../services/relation-input');
const { rederiveUser } = require('../../../../services/estimated-hours-pricing');
const { deriveCostByHour } = require('../../../../services/dedication-cost');
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

// event.state is shared between a query's before and after hooks
const keepUser = (event, id) => {
  event.state = event.state || {};
  event.state.user = id;
};
const keptUser = (event) => (event.state ? event.state.user : undefined);

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
    // the cost per hour the salary gives with the year's working hours, not
    // the one the form computed with the year table it had (issues/416)
    const cost = await deriveCostByHour(data);
    if (cost !== undefined) data.costByHour = cost;
    await updateActivitiesPrice(data);
    // the result carries no relations: the person whose lines afterCreate re-prices
    keepUser(event, relationId(data.users_permissions_user));
  },

  async beforeUpdate(event) {
    const data = event.params.data;
    const id = event.params.where.id;
    // a partial update keeps the saved fields it does not send: dates and
    // hours for the checks, the person for the overlaps, the salary for the
    // cost per hour (issues/416)
    const current =
      (await strapi.db
        .query('api::daily-dedication.daily-dedication')
        .findOne({ where: { id }, populate: { users_permissions_user: { select: ['id'] } } })) || {};
    refuseInvalid(data, current);
    const merged = { ...current };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) merged[k] = v;
    const userId = relationId(data.users_permissions_user) ?? relationId(current.users_permissions_user);

    const dedications = userId
      ? await strapi.db
          .query('api::daily-dedication.daily-dedication')
          .findMany({ where: { users_permissions_user: userId } })
      : [];
    const others = dedications.filter((d) => String(d.id) !== String(id));

    const invalids = others.filter(
      (d) => (merged.to >= d.from && merged.to <= d.to) || (merged.from <= d.to && merged.to >= d.from),
    );
    if (invalids.length) {
      console.error('daily-dedication overlaps', invalids);
      throw new ApplicationError('daily-dedication overlaps');
    }
    const cost = await deriveCostByHour(merged);
    if (cost !== undefined) data.costByHour = cost;
    keepUser(event, userId);
    if (userId && merged.from && merged.to) {
      await updateActivitiesPrice({
        users_permissions_user: userId,
        from: merged.from,
        to: merged.to,
        costByHour: cost !== undefined ? cost : merged.costByHour,
      });
    }
  },

  async beforeDelete(event) {
    // the person whose lines must be re-priced once this period is gone
    const row = await strapi.db
      .query('api::daily-dedication.daily-dedication')
      .findOne({ where: event.params.where, populate: { users_permissions_user: { select: ['id'] } } });
    keepUser(event, relationId(row && row.users_permissions_user));
  },

  // A period's cost changed, or the period itself moved: every planning line
  // of the person may now fall on another period's rate (issues/416).
  // event.result has no relations unless populated: the person comes from the
  // before hook (a partial update doesn't send her).
  async afterCreate(event) {
    await rederiveUser(keptUser(event) ?? relationId(event.result && event.result.users_permissions_user));
  },

  async afterUpdate(event) {
    await rederiveUser(keptUser(event) ?? relationId(event.result && event.result.users_permissions_user));
  },

  async afterDelete(event) {
    await rederiveUser(keptUser(event) ?? relationId(event.result && event.result.users_permissions_user));
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
    if (data.costByHour !== null && data.costByHour !== undefined && Number(ap.cost_by_hour) !== Number(data.costByHour)) {
      await strapi.db
        .query('api::activity.activity')
        .update({ where: { id: ap.id }, data: { cost_by_hour: data.costByHour } });
    }
  }
}
