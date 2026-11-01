'use strict';

/**
 * issues/407 and issues/408 (security review round 4, 2026-11-01):
 * - every sòcia sees every delivery point and orders to it (the order form's
 *   `for-orders` list, by design): what a member reads of someone else's point
 *   is the picker and editing surface, not the office's own fields — the
 *   second e-mail (`contact_email`), the website, the linked app account
 *   (`users_permissions_user`) and the office's integration flags (issues/407);
 * - a populated user's saved `home` (Inici) reached other users (issues/408);
 * - `phase-incomes/assigned` answered a member the ids of every document
 *   assigned to a budget line of the entity, not only her invoices' (issues/408);
 * - the energy module's `loadSupply`/`loadCoefficient` accepted any row id,
 *   without the «Sòcia» check `loadPartner` makes (issues/408).
 */

const { sanitizeResponse, rulesFor } = require('../src/services/response-sanitizer');

const strapi = {
  contentTypes: {
    'api::contact.contact': { attributes: {} },
    'api::project.project': {
      attributes: { leader: { type: 'relation', target: 'plugin::users-permissions.user' } },
    },
    'plugin::users-permissions.user': { attributes: {} },
  },
  components: {},
};

const sharedPoint = () => ({
  id: 51,
  name: 'La Botigueta',
  trade_name: null,
  nif: '40434970G',
  phone: null,
  email: 'a@b.cat',
  address: 'Vall d\u2019ases',
  city: 'Castelló',
  postcode: '17486',
  contact_person: 'Judith',
  contact_phone: '651',
  contact_email: 'office@b.cat',
  website: 'https://b.cat',
  notes: 'n',
  multiowner: true,
  users_permissions_user: { id: 80, username: 'La Botigueta' },
  owner: null,
  externalId: 'EXT',
  face_dir3_oc: 'OC',
  is_client: null,
  is_provider: true,
  partner_amount: 100,
});

describe("the office's fields of someone else's point (issues/407)", () => {
  it('a member keeps the picker and editing fields of a shared point', () => {
    const body = [sharedPoint()];
    sanitizeResponse(strapi, 'api::contact.contact', body, rulesFor({ member: true, selfId: 32, permissions: ['orders'] }));
    expect(body[0]).toEqual({
      id: 51,
      name: 'La Botigueta',
      trade_name: null,
      nif: '40434970G',
      phone: null,
      email: 'a@b.cat',
      address: 'Vall d\u2019ases',
      city: 'Castelló',
      postcode: '17486',
      contact_person: 'Judith',
      contact_phone: '651',
      notes: 'n',
      multiowner: true,
      owner: null,
    });
  });

  it("a member's own card keeps the office's fields she edits", () => {
    const body = [sharedPoint()];
    body[0].owner = { id: 32 };
    body[0].users_permissions_user = { id: 32 };
    sanitizeResponse(strapi, 'api::contact.contact', body, rulesFor({ member: true, selfId: 32, permissions: ['orders'] }));
    expect(body[0].website).toBe('https://b.cat');
    expect(body[0].users_permissions_user).toEqual({ id: 32 });
    expect(body[0].externalId).toBe('EXT');
    expect(body[0].partner_amount).toBeUndefined();
  });

  it('the logistics staff keeps every field of the directory', () => {
    const body = [sharedPoint()];
    sanitizeResponse(strapi, 'api::contact.contact', body, rulesFor({ selfId: 34, permissions: ['orders_delivery'] }));
    expect(body[0].contact_email).toBe('office@b.cat');
    expect(body[0].website).toBe('https://b.cat');
    expect(body[0].users_permissions_user).toEqual({ id: 80, username: 'La Botigueta' });
    expect(body[0].partner_amount).toBeUndefined();
  });
});

describe("a populated user's saved home (issues/408)", () => {
  const project = () => ({ id: 3, name: 'P', leader: { id: 2, username: 'Ana', email: 'a@x.cat', home: { cards: [] } } });

  it('does not reach a worker reading projects/basic', () => {
    const body = [project()];
    sanitizeResponse(strapi, 'api::project.project', body, rulesFor({ selfId: 15, permissions: ['hours'] }));
    expect(body[0].leader.home).toBeUndefined();
    expect(body[0].leader.email).toBe('a@x.cat');
  });

  it('stays on her own row', () => {
    const body = [project()];
    body[0].leader.id = 15;
    sanitizeResponse(strapi, 'api::project.project', body, rulesFor({ selfId: 15, permissions: ['hours'] }));
    expect(body[0].leader.home).toEqual({ cards: [] });
  });
});

describe('phase-incomes/assigned for a member (issues/408)', () => {
  beforeEach(() => jest.resetModules());

  it('narrows the ids to the invoices addressed to her own contacts', async () => {
    const { GENERAL_SCOPES } = require('../src/middlewares/app-permissions');
    const strapiStub = { db: { query: () => ({ findMany: async () => [{ id: 5 }] }) } };
    const ctx = { query: { _limit: '-1', 'filters[invoice][contact][id]': 1 } };
    await GENERAL_SCOPES['api::phase-income.phase-income.findAssigned'](ctx, jest.fn(), {
      strapi: strapiStub,
      userId: 32,
      permissions: ['orders'],
    });
    expect(JSON.stringify(ctx.query)).toContain('invoice.contact.id_in');
  });

  it('leaves the office the whole list', async () => {
    const { GENERAL_SCOPES } = require('../src/middlewares/app-permissions');
    const ctx = { query: { _limit: '-1' } };
    await GENERAL_SCOPES['api::phase-income.phase-income.findAssigned'](ctx, jest.fn(), {
      strapi: { db: { query: () => ({ findMany: async () => [] }) } },
      userId: 99,
      permissions: ['orders_admin'],
    });
    expect(ctx.query).toEqual({ _limit: '-1' });
  });
});

describe('the energy module touches only sòcies (issues/408)', () => {
  beforeEach(() => jest.resetModules());

  const CONTACT_TYPE = 'api::contact-type.contact-type';

  // isPartner reads the «Sòcia» type and the contact-type link of `contactId`
  const partnerDb = (supply, partnerContactIds) => ({
    db: {
      query: (uid) => ({
        findOne: jest.fn(async () => supply),
        findMany: jest.fn(async () => (uid === CONTACT_TYPE ? [{ id: 1, name: 'Sòcia' }] : [])),
      }),
      connection: () => ({
        first: () => ({
          where: async ({ contact_id }) => (partnerContactIds.includes(contact_id) ? { id: 1 } : undefined),
        }),
      }),
    },
  });

  it('refuses a supply of a contact that is not a sòcia', async () => {
    const energy = require('../src/api/energy/services/energy');
    global.strapi = partnerDb({ id: 7, cups: 'ES00ABC', active: true, contact: { id: 51 } }, [80]);
    await expect(energy.updateSupply(7, {})).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(energy.deleteSupply(7)).rejects.toMatchObject({ name: 'NotFoundError' });
    delete global.strapi;
  });

  it('refuses a coefficient whose supply is not a sòcia\u2019s', async () => {
    const energy = require('../src/api/energy/services/energy');
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: jest.fn(async () =>
            uid === 'api::energy.energy-coefficient'
              ? { id: 3, supply: { id: 7, contact: { id: 51 } }, installation: { id: 2 }, coefficient: 0.5 }
              : null,
          ),
          findMany: jest.fn(async () => (uid === CONTACT_TYPE ? [{ id: 1, name: 'Sòcia' }] : [])),
        }),
        connection: () => ({
          first: () => ({ where: async () => undefined }),
        }),
      },
    };
    await expect(energy.updateCoefficient(3, {})).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(energy.deleteCoefficient(3)).rejects.toMatchObject({ name: 'NotFoundError' });
    delete global.strapi;
  });

  it('keeps serving a supply of a sòcia', async () => {
    const energy = require('../src/api/energy/services/energy');
    let updated;
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: jest.fn(async () => ({ id: 7, cups: 'ES00ABC', active: true, contact: { id: 51 } })),
          findMany: jest.fn(async () => (uid === CONTACT_TYPE ? [{ id: 1, name: 'Sòcia' }] : [])),
          update: jest.fn(async ({ where, data }) => {
            updated = { id: where.id, cups: 'ES00ABC', active: true, contact: { id: 51 }, ...data };
            return updated;
          }),
          count: jest.fn(async () => 0),
        }),
        connection: () => ({
          first: () => ({ where: async () => ({ id: 1 }) }),
        }),
      },
    };
    const supply = await energy.updateSupply(7, { holder_name: 'Ana' });
    expect(supply.cups).toBe('ES00ABC');
    expect(updated.holder_name).toBe('Ana');
    delete global.strapi;
  });
});
