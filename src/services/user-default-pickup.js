'use strict';
/* global strapi */

/**
 * The default warehouse of a member (issues/361): the pickup point (a
 * warehouse, `pickup` false) her boxes leave from. The logistics simulator
 * starts from it; the office sets it in «Sòcies» and a member who has none yet
 * picks it in the simulator.
 *
 * `default_pickup` is a private relation of the user (the user lists don't
 * return it), read and written only here:
 *   GET /users/:id/default-pickup          → { pickup: { id, name, alias } | null }
 *   PUT /users/:id/default-pickup { pickup: id | null }
 *   GET /users/default-pickups             → [{ user, pickup }] (the office)
 * `:id` is a user id or `me`. A member reads and writes her own; the office
 * (orders_admin) and the admins, anyone's.
 */
const { errors } = require('@strapi/utils');
const { appPermissionsOf } = require('./app-permissions');

const USER = 'plugin::users-permissions.user';
const PICKUP = 'api::pickup.pickup';
const OFFICE = ['orders_admin', 'admin'];

const pickupOut = (p) => (p ? { id: p.id, name: p.name || '', alias: p.alias || '' } : null);

async function isOffice(userId) {
  const permissions = await appPermissionsOf(userId);
  return permissions.some((p) => OFFICE.includes(p));
}

/** The user the request is about, after checking the caller may touch her. */
async function targetOf(ctx) {
  const caller = ctx.state && ctx.state.user;
  if (!caller) throw new errors.UnauthorizedError();
  const raw = ctx.params && ctx.params.id;
  const id = raw === 'me' || raw === undefined ? caller.id : Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new errors.ValidationError('user id');
  if (id !== caller.id && !(await isOffice(caller.id))) {
    throw new errors.ForbiddenError("Només l'oficina pot canviar el magatzem d'una altra sòcia");
  }
  return id;
}

async function readDefaultPickup(userId) {
  const user = await strapi.db
    .query(USER)
    .findOne({ where: { id: userId }, select: ['id'], populate: { default_pickup: true } });
  if (!user) throw new errors.NotFoundError('user');
  return pickupOut(user.default_pickup);
}

/** Sets it (null clears it); only a warehouse can be the default. */
async function writeDefaultPickup(userId, value) {
  let pickup = null;
  if (value !== null && value !== undefined && value !== '') {
    const id = Number(typeof value === 'object' ? value.id : value);
    if (!Number.isInteger(id) || id <= 0) throw new errors.ValidationError('pickup');
    pickup = await strapi.db.query(PICKUP).findOne({ where: { id } });
    if (!pickup) throw new errors.ValidationError("Aquest magatzem no existeix");
    if (pickup.pickup === true) throw new errors.ValidationError('Una recollida a finca no pot ser el magatzem per defecte');
  }
  const user = await strapi.db.query(USER).findOne({ where: { id: userId }, select: ['id'] });
  if (!user) throw new errors.NotFoundError('user');
  await strapi.db.query(USER).update({ where: { id: userId }, data: { default_pickup: pickup ? pickup.id : null } });
  return pickupOut(pickup);
}

const bodyOf = (ctx) => {
  const body = (ctx.request && ctx.request.body) || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const controllers = {
  async defaultPickup(ctx) {
    ctx.body = { pickup: await readDefaultPickup(await targetOf(ctx)) };
  },
  async updateDefaultPickup(ctx) {
    const id = await targetOf(ctx);
    const body = bodyOf(ctx);
    if (!('pickup' in body)) throw new errors.ValidationError('pickup');
    ctx.body = { pickup: await writeDefaultPickup(id, body.pickup) };
  },
  async defaultPickups(ctx) {
    const caller = ctx.state && ctx.state.user;
    if (!caller) throw new errors.UnauthorizedError();
    if (!(await isOffice(caller.id))) throw new errors.ForbiddenError();
    const users = await strapi.db
      .query(USER)
      .findMany({ select: ['id'], populate: { default_pickup: { select: ['id', 'name', 'alias'] } } });
    ctx.body = users.filter((u) => u.default_pickup).map((u) => ({ user: u.id, pickup: pickupOut(u.default_pickup) }));
  },
};

const routes = [
  { method: 'GET', path: '/users/default-pickups', handler: 'user.defaultPickups', config: { prefix: '' } },
  { method: 'GET', path: '/users/:id/default-pickup', handler: 'user.defaultPickup', config: { prefix: '' } },
  { method: 'PUT', path: '/users/:id/default-pickup', handler: 'user.updateDefaultPickup', config: { prefix: '' } },
];

module.exports = { controllers, routes, readDefaultPickup, writeDefaultPickup };
