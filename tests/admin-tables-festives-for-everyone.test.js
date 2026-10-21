'use strict';

/**
 * issues/310 (2026-10-21): the holidays for everyone could only be changed
 * from the Hores dedicades calendar, one day at a time. They are now an
 * auxiliary table, «Festius de tothom»:
 * - only the rows with no person are listed, newest first;
 * - the form asks for the date and a type for everyone, and has no person
 *   field, so what it saves is a holiday for everyone;
 * - «Festius d'usuari» explains that a row with no person is the year's maximum.
 */

const path = require('path');

const load = async (permissions = [{ permission: 'admin' }]) => {
  jest.resetModules();
  global.strapi = {
    dirs: { app: { root: path.join(__dirname, '..') } },
    db: { query: () => ({ findOne: async () => ({ permissions }) }) },
  };
  const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
  const body = await controller.adminEntities({ state: { user: { id: 1 } } });
  return { body, byName: Object.fromEntries(body.entities.map((e) => [e.name, e])) };
};

afterEach(() => {
  delete global.strapi;
});

describe('«Festius de tothom» admin table (issues/310)', () => {
  it('is listed for admins, with Catalan names, on the festives API', async () => {
    const { byName, body } = await load();
    const f = byName.festive;
    expect(f).toBeTruthy();
    expect(f.apiPath).toBe('festives');
    expect(f.displayName).toBe('Festius de tothom');
    expect(f.displayNameSingular).toBe('Festiu de tothom');
    expect(body.entityToApiPath.festive).toBe('festives');
  });

  it('lists only the holidays with no person, newest first', async () => {
    const { byName } = await load();
    expect(byName.festive.listQuery).toBe('_where[users_permissions_user_null]=true');
    expect(byName.festive.listSort).toEqual(['date', 'desc']);
  });

  it('asks for the date and a type for everyone, and has no person field', async () => {
    const { byName } = await load();
    const attrs = byName.festive.attributes;
    expect(Object.keys(attrs)).toEqual(['date', 'festive_type']);
    expect(attrs.date).toMatchObject({ type: 'date', required: true, label: 'Data' });
    expect(attrs.festive_type).toMatchObject({
      required: true,
      label: 'Tipus de festiu',
      target: 'api::festive-type.festive-type',
      optionsWhere: { personal: false },
    });
    expect(attrs.festive_type.help).toMatch(/Hores dedicades/);
  });

  it('is not offered to the logistics office', async () => {
    const { byName } = await load([{ permission: 'orders_admin' }]);
    expect(byName.festive).toBeUndefined();
  });

  it('leaves the other tables as they were', async () => {
    const { byName } = await load();
    expect(byName['festive-type'].listQuery).toBeUndefined();
    expect(byName['festive-type'].attributes.name.required).toBe(false);
    expect(byName['user-festive'].attributes.users_permissions_user.help).toMatch(/màxim de l'any per a tothom/);
  });
});
