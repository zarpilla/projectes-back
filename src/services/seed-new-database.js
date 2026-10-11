'use strict';
/* global strapi */

/**
 * Startup script: gives a brand-new database what an instance needs to be
 * usable — the catalogs, the settings record (`me`), the home menu, the
 * current year with its invoice series and, optionally, a first user.
 *
 * New instances used to be started by restoring a dump of the empty `buida`
 * tenant. This replaces that restore: point the instance at an empty database
 * and boot it.
 *
 * It only acts on a database that has never been used: no settings record, no
 * users and no years. Every existing tenant has all three, so there it does
 * nothing, and because it is registered runOnce it is not looked at again.
 *
 * Everything is written in one transaction: a failed seed leaves the database
 * empty rather than half filled (the startup-scripts guard won't retry it —
 * delete its `startup_scripts` row, or recreate the database, to run it again).
 */
const { ME_UID } = require('./me-settings');
const seed = require('./new-database-seed-data');

const USER_UID = 'plugin::users-permissions.user';
const YEAR_UID = 'api::year.year';

async function isNewDatabase() {
  for (const uid of [ME_UID, USER_UID, YEAR_UID]) {
    if ((await strapi.db.query(uid).count()) > 0) return false;
  }
  return true;
}

/** The front is served under /stats/ of the same host (see ensure-reset-password-url). */
function frontUrl() {
  const serverUrl = String(strapi.config.get('server.url') || '').replace(/\/+$/, '');
  return /^https?:\/\//.test(serverUrl) ? `${serverUrl}/stats/#/` : null;
}

async function seedFirstUser() {
  const email = process.env.SEED_USER_EMAIL;
  const password = process.env.SEED_USER_PASSWORD;
  if (!email || !password) {
    strapi.log.info('[seedNewDatabase] no SEED_USER_EMAIL / SEED_USER_PASSWORD: no user created');
    return;
  }
  const role = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'authenticated' } });
  await strapi.documents(USER_UID).create({
    data: {
      username: process.env.SEED_USER_NAME || email,
      email: email.toLowerCase(),
      password,
      provider: 'local',
      confirmed: true,
      blocked: false,
      role: role && role.id,
      permissions: seed.FIRST_USER_PERMISSIONS.map((permission) => ({ permission })),
    },
  });
  strapi.log.info(`[seedNewDatabase] user ${email} created`);
}

async function seedNewDatabase() {
  if (!(await isNewDatabase())) {
    strapi.log.info('[seedNewDatabase] database already in use: nothing to seed');
    return;
  }

  await strapi.db.transaction(async () => {
    const festiveTypes = {};
    for (const [uid, rows] of Object.entries(seed.CATALOGS)) {
      for (const data of rows) {
        const created = await strapi.documents(uid).create({ data });
        if (uid === 'api::festive-type.festive-type') festiveTypes[data.name] = created.id;
      }
    }

    const year = new Date().getFullYear();
    await strapi.documents(YEAR_UID).create({ data: { year, ...seed.YEAR_DEFAULTS } });
    await strapi
      .documents('api::serie.serie')
      .create({ data: { name: String(year), ...seed.SERIE_DEFAULTS } });
    for (const [date, type] of seed.FESTIVES) {
      if (Number(date.slice(0, 4)) < year) continue;
      await strapi
        .documents('api::festive.festive')
        .create({ data: { date, festive_type: festiveTypes[type] } });
    }

    const front_url = frontUrl();
    await strapi.documents(ME_UID).create({ data: { ...seed.ME, front_url } });
    await strapi.documents('api::config.config').create({ data: { front_url } });
    await strapi.documents('api::home-menu.home-menu').create({ data: { homegroup: seed.HOME_MENU } });

    await seedFirstUser();
  });

  strapi.log.info('[seedNewDatabase] new database seeded');
}

module.exports = { seedNewDatabase, isNewDatabase };
