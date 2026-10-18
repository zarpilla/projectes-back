'use strict';

/**
 * issues/154 (2026-10-18): a reply on an incidence was e-mailed to the member
 * only (when the office or a driver replied) or to contact_form_email only
 * (when the member replied), so the rest of the office staff never heard of
 * it. Now a new reply goes to contact_form_email, every active orders_admin
 * user and the order's owner, without the reply's author and without repeats.
 * Updates that add no reply keep the old recipients.
 */

const path = require('path');

const OWNER = { id: 10, email: 'member@coop.cat', fullname: 'Sòcia' };
const ADMIN_A = {
  id: 1,
  email: 'office-a@coop.cat',
  blocked: false,
  permissions: [{ permission: 'orders_admin' }],
};
const ADMIN_B = {
  id: 2,
  email: 'Office@coop.cat',
  blocked: false,
  permissions: [{ permission: 'orders_admin' }],
};
const DRIVER = {
  id: 3,
  email: 'driver@coop.cat',
  blocked: false,
  permissions: [{ permission: 'orders_delivery' }],
};

function load({ repliesBefore, repliesAfter, state = 'open' }) {
  jest.resetModules();
  const send = jest.fn(async () => {});
  const userQuery = jest.fn(async ({ where }) =>
    [ADMIN_A, ADMIN_B, DRIVER, OWNER].filter((u) => !(where && where.blocked === false && u.blocked)),
  );
  let calls = 0;
  global.strapi = {
    db: {
      query: (uid) => {
        if (uid === 'plugin::users-permissions.user') return { findMany: userQuery };
        return {
          findOne: async () => {
            calls += 1;
            // first call: beforeUpdate; then the lifecycle's full load
            if (calls === 1) return { id: 5, incidence_response: repliesBefore };
            return {
              id: 5,
              state,
              description: 'Caixa trencada',
              order: { id: 77, owner: OWNER },
              incidence_response: repliesAfter,
            };
          },
        };
      },
    },
    documents: (uid) => ({
      findFirst: async () =>
        uid === 'api::me.me'
          ? { name: 'Coop', contact_form_email: 'office@coop.cat, logistica@coop.cat' }
          : {},
    }),
    config: { get: () => 'noreply@coop.cat' },
    plugin: () => ({ service: () => ({ send }) }),
  };
  const lifecycles = require(
    path.join(__dirname, '..', 'src', 'api', 'incidence', 'content-types', 'incidence', 'lifecycles'),
  );
  const updater = require(path.join(__dirname, '..', 'src', 'api', 'incidence', 'utils', 'updater'));
  return { lifecycles, updater, send };
}

async function update({ lifecycles, updater }, userId) {
  const event = { params: { where: { id: 5 } }, state: {}, result: { id: 5 } };
  await lifecycles.beforeUpdate(event);
  updater.setCurrentUserId(userId);
  await lifecycles.afterUpdate(event);
}

const sorted = (list) => [...list].sort();

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete global.strapi;
  jest.restoreAllMocks();
});

describe('incidence reply e-mails (issues/154)', () => {
  it('an office reply reaches the member and the other office staff, not its author', async () => {
    const t = load({
      repliesBefore: [],
      repliesAfter: [{ text: 'Ho mirem', user: { id: 1, email: 'office-a@coop.cat' } }],
    });
    await update(t, 1);
    expect(t.send).toHaveBeenCalledTimes(1);
    const { to, subject, html } = t.send.mock.calls[0][0];
    expect(sorted(to)).toEqual(sorted(['office@coop.cat', 'logistica@coop.cat', 'member@coop.cat']));
    expect(subject).toContain('resposta nova');
    expect(html).toContain('Ho mirem');
  });

  it("a member's reply reaches contact_form_email and every orders_admin user once", async () => {
    const t = load({
      repliesBefore: [{ text: 'Hola' }],
      repliesAfter: [{ text: 'Hola' }, { text: 'Encara no', user: { id: 10 } }],
    });
    await update(t, 10);
    const { to } = t.send.mock.calls[0][0];
    // Office@coop.cat (ADMIN_B) is the same address as contact_form_email's office@coop.cat
    expect(sorted(to)).toEqual(sorted(['office@coop.cat', 'logistica@coop.cat', 'office-a@coop.cat']));
  });

  it("a driver's reply reaches the office and the member", async () => {
    const t = load({ repliesBefore: [], repliesAfter: [{ text: 'Lliurat', user: { id: 3 } }] });
    await update(t, 3);
    const { to } = t.send.mock.calls[0][0];
    expect(sorted(to)).toEqual(
      sorted(['office@coop.cat', 'logistica@coop.cat', 'office-a@coop.cat', 'member@coop.cat']),
    );
  });

  it('an update without a new reply still mails the member only', async () => {
    const replies = [{ text: 'Ho mirem', user: { id: 1 } }];
    const t = load({ repliesBefore: replies, repliesAfter: replies, state: 'closed' });
    await update(t, 1);
    expect(t.send.mock.calls[0][0].to).toEqual(['member@coop.cat']);
  });
});
