'use strict';
/* global strapi */

/**
 * Inici (the front's #/inici): the menu entries a person pins with a star and
 * the page they open after login. Kept on their own user (`home`, a private
 * field: GET /users/me and the user lists don't return it) and read and written
 * only through GET/PUT /api/users/me/home, so nobody sees or changes another
 * person's.
 */
const { errors } = require('@strapi/utils');

const USER = 'plugin::users-permissions.user';
const LANDINGS = ['home', 'usual', 'first'];
const MAX_PINS = 60;
const MAX_PATH = 200;

/** The body checked and cleaned up; throws a ValidationError when it isn't a home. */
function parseHome(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
  if (!data || typeof data !== 'object' || !Array.isArray(data.pins)) {
    throw new errors.ValidationError('home needs a list of pins');
  }
  if (data.pins.length > MAX_PINS) throw new errors.ValidationError(`at most ${MAX_PINS} pins`);
  for (const pin of data.pins) {
    if (typeof pin !== 'string' || !pin.startsWith('/') || pin.length > MAX_PATH) {
      throw new errors.ValidationError('each pin is a path of the app');
    }
  }
  if (data.landing !== undefined && !LANDINGS.includes(data.landing)) {
    throw new errors.ValidationError(`landing is one of ${LANDINGS.join(', ')}`);
  }
  return { pins: [...new Set(data.pins)], landing: data.landing || 'home' };
}

/** The saved home of a user, or null when they never saved one. */
async function readHome(userId) {
  const user = await strapi.db.query(USER).findOne({ where: { id: userId }, select: ['id', 'home'] });
  return (user && user.home) || null;
}

async function writeHome(userId, body) {
  const home = parseHome(body);
  await strapi.db.query(USER).update({ where: { id: userId }, data: { home } });
  return home;
}

/**
 * The two actions of the users-permissions `user` controller. Flat bodies, like
 * the plugin's other /users routes: `{ home }` back, `{ pins, landing }` in.
 */
const controllers = {
  async home(ctx) {
    const user = ctx.state && ctx.state.user;
    if (!user) throw new errors.UnauthorizedError();
    ctx.body = { home: await readHome(user.id) };
  },
  async updateHome(ctx) {
    const user = ctx.state && ctx.state.user;
    if (!user) throw new errors.UnauthorizedError();
    ctx.body = { home: await writeHome(user.id, ctx.request && ctx.request.body) };
  },
};

const routes = [
  { method: 'GET', path: '/users/me/home', handler: 'user.home', config: { prefix: '' } },
  { method: 'PUT', path: '/users/me/home', handler: 'user.updateHome', config: { prefix: '' } },
];

module.exports = { parseHome, readHome, writeHome, controllers, routes, LANDINGS };
