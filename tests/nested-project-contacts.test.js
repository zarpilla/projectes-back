'use strict';

/**
 * issues/399 (security review round 3, 2026-11-01):
 * - on a copy of Resilience worker 37 (`hours` only) asked for
 *   `tasks?populate[project][populate][clients]=true` and got 36 client rows
 *   with NIF, e-mail, phone, address, notes and partner amount;
 * - on a copy of La Diligència driver 34 read every contact with the partners'
 *   `partner_amount` and its date.
 * A nested project now carries its contacts' names only, and the partners'
 * money stays with the office and full access (also out of a driver's writes).
 */
const { sanitizeResponse, rulesFor } = require('../src/services/response-sanitizer');

const strapi = {
  contentTypes: {
    'api::task.task': { attributes: { project: { type: 'relation', target: 'api::project.project' } } },
    'api::project.project': {
      attributes: {
        clients: { type: 'relation', target: 'api::contact.contact' },
        grantable_leader: { type: 'relation', target: 'api::contact.contact' },
        leader: { type: 'relation', target: 'plugin::users-permissions.user' },
      },
    },
    'api::contact.contact': { attributes: {} },
    'plugin::users-permissions.user': { attributes: {} },
  },
  components: {},
};

const client = () => ({ id: 7, name: 'Ajuntament', trade_name: 'Aj.', nif: 'P1700000A', email: 'a@aj.cat', phone: '972', address: 'Pl. 1', notes: 'n', partner_amount: 100 });
const task = () => ({
  id: 1,
  name: 'Tasca',
  project: { id: 3, name: 'Projecte', description: 'd', purpose: 'p', clients: [client()], grantable_leader: client(), strategies: [{ id: 1 }], leader: { id: 2, username: 'x' } },
});

describe('a nested project for users without full access (issues/399)', () => {
  it('a worker gets the names of its contacts, not their data', () => {
    const body = { data: [task()] };
    sanitizeResponse(strapi, 'api::task.task', body, rulesFor({ selfId: 37, permissions: ['hours'] }));
    const { project } = body.data[0];
    expect(project.clients).toEqual([{ id: 7, name: 'Ajuntament', trade_name: 'Aj.' }]);
    expect(project.grantable_leader).toEqual({ id: 7, name: 'Ajuntament', trade_name: 'Aj.' });
    expect(project.strategies).toBeUndefined();
    expect(project.description).toBe('d');
    expect(project.leader).toEqual({ id: 2, username: 'x' });
  });

  it('a member gets the project name only', () => {
    const body = { data: [task()] };
    sanitizeResponse(strapi, 'api::task.task', body, rulesFor({ member: true, selfId: 32, permissions: ['orders'] }));
    expect(body.data[0].project.description).toBeUndefined();
    expect(body.data[0].project.purpose).toBeUndefined();
    expect(body.data[0].project.clients).toEqual([{ id: 7, name: 'Ajuntament', trade_name: 'Aj.' }]);
  });
});

describe("the partners' money on contacts (issues/399)", () => {
  const contact = () => ({ id: 9, name: 'Sòcia', nif: 'X', phone: '6', partner_amount: 300, partner_amount_date: '2024-01-01', capital_contributions: [{ amount: 1 }], followup_date: '2026-01-01' });

  it('drivers and workers do not get it, the office does', () => {
    for (const permissions of [['orders_delivery', 'hours'], ['hours']]) {
      const body = { data: [contact()] };
      sanitizeResponse(strapi, 'api::contact.contact', body, rulesFor({ selfId: 34, permissions }));
      expect(body.data[0]).toEqual({ id: 9, name: 'Sòcia', nif: 'X', phone: '6' });
    }
    const office = { data: [contact()] };
    sanitizeResponse(strapi, 'api::contact.contact', office, rulesFor({ selfId: 27, permissions: ['orders_admin', 'orders_delivery'] }));
    expect(office.data[0].partner_amount).toBe(300);
  });

  it("a driver's contact write leaves it alone", async () => {
    jest.resetModules();
    const { DRIVER_SCOPES } = require('../src/middlewares/app-permissions');
    const ctx = { request: { body: { data: { name: 'P', partner_amount: 0, capital_contributions: [], followup_date: null } } } };
    const next = jest.fn();
    await DRIVER_SCOPES['api::contact.contact.create'](ctx, next, {});
    expect(ctx.request.body.data).toEqual({ name: 'P' });
    expect(next).toHaveBeenCalled();
  });
});
