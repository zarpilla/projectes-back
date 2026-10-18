'use strict';

/**
 * Inici (front #/inici, 2026-10-18): each person pins menu entries with a star
 * and chooses the page opened after login. It was first kept in the browser's
 * localStorage; the team chose to keep it on the user so it follows the person
 * to every browser. GET/PUT /api/users/me/home read and write only the caller's
 * own `home` (a private field), for any logged-in user.
 */

const path = require('path');

const EXTENSION = path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'strapi-server.js');

function stubStrapi(rows) {
  const update = jest.fn(async ({ where, data }) => {
    rows[where.id] = { ...rows[where.id], ...data };
    return rows[where.id];
  });
  global.strapi = {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => rows[where.id] || null),
        update,
      })),
    },
  };
  return { update };
}

const ctxAs = (user, body) => ({ state: { user }, request: { body } });

describe('users/me/home', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('cleans up a valid home and refuses anything else', () => {
    const { parseHome } = require('../src/services/user-home');
    expect(parseHome({ pins: ['/tasks', '/vat', '/tasks'], landing: 'first' })).toEqual({ pins: ['/tasks', '/vat'], landing: 'first' });
    expect(parseHome({ data: { pins: [] } })).toEqual({ pins: [], landing: 'home' });
    for (const bad of [null, {}, { pins: '/tasks' }, { pins: ['tasks'] }, { pins: [3] }, { pins: ['/x'.repeat(150)] },
      { pins: Array.from({ length: 61 }, (_, i) => `/p${i}`) }, { pins: [], landing: 'elsewhere' }]) {
      expect(() => parseHome(bad)).toThrow(expect.objectContaining({ name: 'ValidationError' }));
    }
  });

  it('reads and writes the caller\'s own home only', async () => {
    const rows = { 5: { id: 5, home: null }, 6: { id: 6, home: { pins: ['/salary'], landing: 'home' } } };
    const { update } = stubStrapi(rows);
    const { controllers } = require('../src/services/user-home');

    const read = ctxAs({ id: 5 });
    await controllers.home(read);
    expect(read.body).toEqual({ home: null });

    const write = ctxAs({ id: 5 }, { pins: ['/tasks'], landing: 'usual' });
    await controllers.updateHome(write);
    expect(write.body).toEqual({ home: { pins: ['/tasks'], landing: 'usual' } });
    expect(update).toHaveBeenCalledWith({ where: { id: 5 }, data: { home: { pins: ['/tasks'], landing: 'usual' } } });
    expect(rows[6].home).toEqual({ pins: ['/salary'], landing: 'home' });

    const again = ctxAs({ id: 5 });
    await controllers.home(again);
    expect(again.body).toEqual({ home: { pins: ['/tasks'], landing: 'usual' } });
  });

  it('refuses requests without a user and does not save an invalid body', async () => {
    const { update } = stubStrapi({ 5: { id: 5 } });
    const { controllers } = require('../src/services/user-home');
    await expect(controllers.home(ctxAs(undefined))).rejects.toMatchObject({ name: 'UnauthorizedError' });
    await expect(controllers.updateHome(ctxAs({ id: 5 }, { pins: 'x' }))).rejects.toMatchObject({ name: 'ValidationError' });
    expect(update).not.toHaveBeenCalled();
  });

  it('is mounted on the users-permissions plugin, before /users/:id', () => {
    stubStrapi({});
    let routes = [{ method: 'GET', path: '/users/:id', handler: 'user.findOne' }];
    const contentApi = () => ({ type: 'content-api', routes });
    Object.defineProperty(contentApi, 'routes', { get: () => routes, set: (next) => { routes = next; } });
    const plugin = { controllers: { user: { create: jest.fn(), update: jest.fn() } }, routes: { 'content-api': contentApi } };
    const p = require(EXTENSION)(plugin);
    expect(typeof p.controllers.user.home).toBe('function');
    expect(typeof p.controllers.user.updateHome).toBe('function');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /users/me/home', 'PUT /users/me/home', 'GET /users/:id']);
  });

  it('is open to every logged-in user, whatever their app permissions', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const action of ['home', 'updateHome']) {
      for (const permissions of [[], ['hours'], ['orders'], ['orders_delivery'], ['projects']]) {
        expect(isAllowed(`plugin::users-permissions.user.${action}`, permissions)).toBe(true);
      }
    }
  });
});
