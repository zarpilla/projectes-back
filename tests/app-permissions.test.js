'use strict';

/**
 * issues/099 (2026-10-17): the app permissions were only applied by the front
 * end. Any logged-in user, a logistics member with only `orders` included,
 * could call the API directly and read payrolls, salaries, invoices, projects
 * and other members' orders, and change orders, contacts, invoices and
 * projects (checked against La Diligència's data with a member's JWT).
 *
 * These tests run the app-permissions middleware with a fake ctx: one block per
 * permission with what its screens call (must pass) and what they don't
 * (must be refused), then the member's owner scoping.
 */

const ME = 100;
const OTHER = 200;
const MY_CONTACT = 7; // the contact linked to the member's user

function makeStrapi({
  permissions,
  orders = {},
  contacts = {},
  incidences = {},
  rows = {},
  contentTypes = {},
}) {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'plugin::users-permissions.user') {
        return {
          id: where.id,
          permissions: (permissions[where.id] || []).map((permission) => ({ permission })),
        };
      }
      const table = {
        'api::order.order': orders,
        'api::contact.contact': contacts,
        'api::incidence.incidence': incidences,
        ...rows,
      }[uid];
      return (table && table[where.id]) || null;
    }),
    findMany: jest.fn(async ({ where }) => {
      if (uid === 'api::contact.contact' && where.users_permissions_user) {
        return Object.values(contacts).filter(
          (c) => c.users_permissions_user && c.users_permissions_user.id === where.users_permissions_user.id,
        );
      }
      if (uid === 'api::order.order' && where.owner) {
        return Object.values(orders).filter((o) => o.owner.id === where.owner.id);
      }
      if (uid === 'api::order.order') return where.id.$in.map((id) => orders[id]).filter(Boolean);
      return [];
    }),
    count: jest.fn(
      async ({ where }) =>
        Object.values(orders).filter(
          (o) => o.owner.id === where.owner.id && o.contact.id === where.contact.id,
        ).length,
    ),
  });
  return { db: { query: jest.fn(query) }, contentTypes, components: {} };
}

function route(handler, info) {
  return { handler, info: info || { apiName: handler.split('::')[1].split('.')[0] } };
}

function makeCtx({ handler, info, method = 'GET', userId = ME, query = {}, body, params = {}, numericId }) {
  return {
    method,
    query,
    params,
    request: { body },
    state: {
      user: userId ? { id: userId } : undefined,
      route: route(handler, info),
      v3: numericId !== undefined ? { numericId } : undefined,
    },
  };
}

let middleware;
let strapi;

function setup(options) {
  jest.resetModules();
  strapi = makeStrapi(options);
  middleware = require('../src/middlewares/app-permissions')({}, { strapi });
}

async function run(ctx, answer) {
  const next = jest.fn(async () => {
    if (answer !== undefined) ctx.body = answer;
  });
  await middleware(ctx, next);
  return next;
}

async function expectAllowed(handler, opts = {}) {
  const ctx = makeCtx({ handler, ...opts });
  const next = await run(ctx);
  expect(next).toHaveBeenCalled();
  return ctx;
}

async function expectRefused(handler, opts = {}) {
  const ctx = makeCtx({ handler, ...opts });
  await expect(run(ctx)).rejects.toMatchObject({ name: 'ForbiddenError' });
}

const ORDER = (owner, contact) => ({ owner: { id: owner }, contact: { id: contact } });

describe('app permissions (issues/099)', () => {
  describe('projects and admin keep everything', () => {
    it.each([['projects'], ['admin']])('%s', async (permission) => {
      setup({ permissions: { [ME]: [permission] } });
      await expectAllowed('api::payroll.payroll.find');
      await expectAllowed('api::bank-account.bank-account.find');
      await expectAllowed('api::project.project.update', { method: 'PUT' });
      await expectAllowed('api::order.order.find');
    });

    it('does not narrow their queries', async () => {
      setup({ permissions: { [ME]: ['projects', 'orders'] } });
      const ctx = await expectAllowed('api::order.order.find', { query: { _where: { owner: OTHER } } });
      expect(ctx.query).toEqual({ _where: { owner: OTHER } });
    });
  });

  it('leaves public routes (no user) to the Public role', async () => {
    setup({ permissions: {} });
    await expectAllowed('api::logo.logo.find', { userId: null });
    await expectAllowed('plugin::users-permissions.auth.callback', {
      userId: null,
      info: { pluginName: 'users-permissions' },
    });
  });

  it('lets a user with no app permission read only herself, the entity and the logos', async () => {
    setup({ permissions: { [ME]: [] } });
    await expectAllowed('user.me', { info: { pluginName: 'users-permissions' } });
    await expectAllowed('api::me.me.find');
    await expectAllowed('api::logo.logo.find');
    await expectAllowed('plugin::users-permissions.auth.logout', { method: 'POST' });
    await expectRefused('api::order.order.find');
    await expectRefused('user.find', { info: { pluginName: 'users-permissions' } });
  });

  describe('orders (member)', () => {
    beforeEach(() => setup({ permissions: { [ME]: ['orders'] } }));

    it.each([
      'api::order.order.table',
      'api::order.order.checkMultidelivery',
      'api::order.order.collectionPointRoutes',
      'api::contact.contact.forOrders',
      'api::contact.contact.basic',
      'api::contact.contact.withorders',
      'api::contact.contact.find',
      'api::emitted-invoice.emitted-invoice.pendingProvider',
      'api::emitted-invoice.emitted-invoice.findBasic',
      'api::received-income.received-income.findBasic',
      'api::phase-income.phase-income.findAssigned',
      'api::project.project.findWithBasicInfo',
      'api::route.route.find',
      'api::city-route.city-route.basic',
      'api::route-festive.route-festive.find',
      'api::festive.festive.find',
      'api::pickup.pickup.find',
      'api::form-submission.form-submission.create',
      'api::orders-import.orders-import.create',
      'plugin::upload.content-api.upload',
    ])('may call %s', async (handler) => {
      await expectAllowed(handler, { body: {} });
    });

    it('may read the users and herself', async () => {
      await expectAllowed('user.find', { info: { pluginName: 'users-permissions' } });
      await expectAllowed('user.me', { info: { pluginName: 'users-permissions' } });
    });

    it.each([
      'api::payroll.payroll.find',
      'api::daily-dedication.daily-dedication.find',
      'api::bank-account.bank-account.find',
      'api::emitted-invoice.emitted-invoice.find',
      'api::emitted-invoice.emitted-invoice.update',
      'api::received-invoice.received-invoice.find',
      'api::project.project.find',
      'api::project.project.update',
      'api::project.project.findWithPhasesBoth',
      'api::activity.activity.find',
      'api::order.order.delete',
      'api::order.order.invoice',
      'api::order.order.infoAll',
      'api::incidence.incidence.infoAll',
      'api::contact.contact.delete',
      'api::contact.contact.unify',
      'api::contact.contact.nifMatches',
      'api::contact.contact.summary',
      'api::contact.contact.orders',
      'api::city-route.city-route.create',
      'api::route-festive.route-festive.create',
      'api::city.city.create',
      'api::task.task.find',
      'api::me.me.update',
    ])('is refused %s', async (handler) => {
      await expectRefused(handler);
    });

    it('leaves the bank accounts and certificates out of /api/me', async () => {
      const ctx = makeCtx({ handler: 'api::me.me.find' });
      await run(ctx, {
        data: {
          name: 'Entitat',
          orders_options: { next_day_limit_hour: 14 },
          bank_account_default: { iban: 'ES00' },
          face_certificate: {},
        },
      });
      expect(ctx.body.data).toEqual({ name: 'Entitat', orders_options: { next_day_limit_hour: 14 } });
    });
  });

  describe('orders_admin and orders_delivery (logistics staff)', () => {
    it('orders_admin reaches the office screens, not payrolls nor projects', async () => {
      setup({ permissions: { [ME]: ['orders_admin'] } });
      for (const handler of [
        'api::order.order.invoice',
        'api::order.order.infoAll',
        'api::incidence.incidence.infoAll',
        'api::emitted-invoice.emitted-invoice.find',
        'api::contact.contact.unify',
        'api::contact.contact.nifMatches',
        'api::contact.contact.orders',
        'api::contact.contact.delete',
        'api::me.me.dir3SearchNif',
      ]) {
        await expectAllowed(handler);
      }
      await expectAllowed('api::pivot-table-view.pivot-table-view.create', {
        method: 'POST',
        body: { data: { identifier: 'orders-pivot' } },
      });
      await expectRefused('api::payroll.payroll.find');
      // the «Resum» of a contact is the projects' finances
      await expectRefused('api::contact.contact.summary');
      await expectRefused('api::project.project.update');
      await expectRefused('api::emitted-invoice.emitted-invoice.update');
    });

    it('orders_delivery marks orders but does not invoice them', async () => {
      setup({
        permissions: { [ME]: ['orders_delivery'] },
        orders: { 1: { id: 1, status: 'processed', ...ORDER(OTHER, 8) } },
      });
      await expectAllowed('api::order.order.update', {
        method: 'PUT',
        body: { data: { status: 'delivered' } },
        numericId: 1,
      });
      await expectAllowed('api::city-route.city-route.create');
      await expectRefused('api::order.order.invoice');
      await expectRefused('api::order.order.infoAll');
    });

    it('is not narrowed to her own orders', async () => {
      setup({ permissions: { [ME]: ['orders', 'orders_delivery'] } });
      const ctx = await expectAllowed('api::order.order.find', { query: { _limit: '1' } });
      expect(ctx.query).toEqual({ _limit: '1' });
    });
  });

  describe('hours (workers)', () => {
    beforeEach(() => setup({ permissions: { [ME]: ['hours'] } }));

    it.each([
      'api::activity.activity.getForCalendar',
      // update, delete and importCalendar on her own rows: «a worker's own rows» below
      'api::activity.activity.create',
      'api::activity.activity.move',
      'api::time-counter.time-counter.create',
      'api::workday-log.workday-log.create',
      'api::daily-dedication.daily-dedication.find',
      'api::festive.festive.create',
      'api::project.project.findWithBasicInfo',
      'api::project.project.findWithPhasesBoth',
      'api::contact.contact.basic',
      'api::task.task.find',
      'api::pivot-table-view.pivot-table-view.find',
      'api::dedication-type.dedication-type.find',
      'api::activity-type.activity-type.getBasic',
    ])('may call %s', async (handler) => {
      await expectAllowed(handler);
    });

    it.each([
      'api::payroll.payroll.find',
      'api::payroll.payroll.createAll',
      'api::bank-account.bank-account.find',
      'api::emitted-invoice.emitted-invoice.find',
      'api::received-invoice.received-invoice.find',
      'api::project.project.find',
      'api::project.project.findOneExtended',
      'api::project.project.update',
      'api::order.order.find',
      'api::contact.contact.update',
      'api::treasury.treasury.find',
    ])('is refused %s', async (handler) => {
      await expectRefused(handler);
    });
  });

  describe("a worker's own rows (hours)", () => {
    const ACTIVITY = 'api::activity.activity';
    const MINE = 1;
    const THEIRS = 2;
    const own = {
      [MINE]: { users_permissions_user: { id: ME } },
      [THEIRS]: { users_permissions_user: { id: OTHER } },
    };

    beforeEach(() =>
      setup({
        permissions: { [ME]: ['hours'] },
        rows: {
          [ACTIVITY]: own,
          'api::time-counter.time-counter': own,
          'api::workday-log.workday-log': own,
          'api::daily-dedication.daily-dedication': own,
          'api::festive.festive': own,
        },
      }),
    );

    it.each([
      `${ACTIVITY}.find`,
      `${ACTIVITY}.getForCalendar`,
      'api::time-counter.time-counter.find',
      'api::workday-log.workday-log.find',
      'api::daily-dedication.daily-dedication.find',
    ])('narrows %s to her own rows, whatever the query asks', async (handler) => {
      const ctx = await expectAllowed(handler, {
        query: { _where: { 'users_permissions_user.id': OTHER } },
      });
      expect(ctx.query._where).toEqual({
        _and: [{ 'users_permissions_user.id': ME }, { 'users_permissions_user.id': OTHER }],
      });
    });

    it.each([
      [ACTIVITY, 'update', 'PUT'],
      [ACTIVITY, 'delete', 'DELETE'],
      ['api::time-counter.time-counter', 'update', 'PUT'],
      ['api::workday-log.workday-log', 'delete', 'DELETE'],
      ['api::festive.festive', 'update', 'PUT'],
      ['api::festive.festive', 'delete', 'DELETE'],
    ])("refuses %s.%s on someone else's row, allows it on hers", async (uid, action, method) => {
      await expectRefused(`${uid}.${action}`, { method, numericId: THEIRS, body: {} });
      await expectAllowed(`${uid}.${action}`, { method, numericId: MINE, body: {} });
    });

    it('creates hours, counters, workday logs and holidays as herself only', async () => {
      for (const uid of [
        ACTIVITY,
        'api::time-counter.time-counter',
        'api::workday-log.workday-log',
        'api::festive.festive',
      ]) {
        const ctx = await expectAllowed(`${uid}.create`, { method: 'POST', body: { data: { hours: 2 } } });
        expect(ctx.request.body.data.users_permissions_user).toBe(ME);
        await expectRefused(`${uid}.create`, {
          method: 'POST',
          body: { data: { users_permissions_user: OTHER } },
        });
      }
    });

    it('cannot hand her own hours to someone else', async () => {
      await expectRefused(`${ACTIVITY}.update`, {
        method: 'PUT',
        numericId: MINE,
        body: { data: { users_permissions_user: { id: OTHER } } },
      });
    });

    it('moves and imports only her own hours', async () => {
      const ctx = await expectAllowed(`${ACTIVITY}.move`, { method: 'POST', body: { from: 1, to: 2 } });
      expect(ctx.request.body.user).toBe(ME);
      await expectRefused(`${ACTIVITY}.move`, { method: 'POST', body: { user: OTHER, from: 1, to: 2 } });
      await expectAllowed(`${ACTIVITY}.importCalendar`, { params: { id: String(ME) } });
      await expectRefused(`${ACTIVITY}.importCalendar`, { params: { id: String(OTHER) } });
    });

    it('reads her working periods without the salary fields', async () => {
      const period = {
        id: 5,
        from: '2026-01-01',
        hours: 8,
        hoursperday: '8,8,8,8,7',
        costByHour: 21,
        monthly_salary: 2100,
        pct_irpf: 12,
      };
      const ctx = makeCtx({ handler: 'api::daily-dedication.daily-dedication.find' });
      await run(ctx, { data: [{ ...period }], meta: {} });
      expect(ctx.body.data).toEqual([{ id: 5, from: '2026-01-01', hours: 8, hoursperday: '8,8,8,8,7' }]);
    });

    it('a worker with logistics permissions too is still limited to her own hours', async () => {
      setup({ permissions: { [ME]: ['hours', 'orders_admin'] }, rows: { [ACTIVITY]: own } });
      await expectRefused(`${ACTIVITY}.update`, { method: 'PUT', numericId: THEIRS, body: {} });
    });

    it('projects keep the «Persona» picker: no narrowing', async () => {
      setup({ permissions: { [ME]: ['projects'] }, rows: { [ACTIVITY]: own } });
      const ctx = await expectAllowed(`${ACTIVITY}.getForCalendar`, { query: {} });
      expect(ctx.query).toEqual({});
      await expectAllowed(`${ACTIVITY}.update`, { method: 'PUT', numericId: THEIRS, body: {} });
    });
  });

  describe("a member's owner scoping", () => {
    const options = () => ({
      permissions: { [ME]: ['orders'] },
      contacts: {
        [MY_CONTACT]: { id: MY_CONTACT, users_permissions_user: { id: ME }, owner: null },
        8: { id: 8, owner: { id: OTHER }, users_permissions_user: null },
        9: { id: 9, owner: { id: OTHER }, users_permissions_user: null, multiowner: true },
        10: { id: 10, owner: { id: ME }, users_permissions_user: null },
        11: { id: 11, owner: { id: OTHER }, users_permissions_user: null },
        12: { id: 12, owner: { id: OTHER }, users_permissions_user: null },
      },
      orders: {
        1: { id: 1, status: 'pending', ...ORDER(ME, 8) },
        2: { id: 2, status: 'pending', ...ORDER(OTHER, 8) },
        3: { id: 3, status: 'pending', ...ORDER(OTHER, MY_CONTACT) },
        4: { id: 4, status: 'pending', ...ORDER(ME, 11) },
        5: { id: 5, status: 'processed', ...ORDER(ME, 8) },
        6: { id: 6, status: 'delivered', ...ORDER(ME, 8) },
        13: { id: 13, status: 'invoiced', ...ORDER(ME, 8) },
        14: { id: 14, status: 'cancelled', ...ORDER(ME, 8) },
      },
      incidences: { 50: { id: 50, order: { id: 1 } }, 51: { id: 51, order: { id: 2 } } },
    });
    beforeEach(() => setup(options()));

    it('narrows the order list to hers and the ones delivered to her contact, whatever the query asks', async () => {
      const ctx = await expectAllowed('api::order.order.find', {
        query: { _where: { status: 'pending' }, filters: { id: 2 }, _limit: '1' },
      });
      expect(ctx.query._where).toEqual({
        _and: [{ _or: [{ 'owner.id': ME }, { 'contact.id_in': [MY_CONTACT] }] }, { status: 'pending' }],
      });
      expect(ctx.query.filters).toEqual({
        $and: [{ $or: [{ owner: { id: ME } }, { contact: { id: { $in: [MY_CONTACT] } } }] }, { id: 2 }],
      });
      expect(ctx.query._limit).toBe('1');
    });

    it('builds the v5 filters the query adapter expects from the v3 clause', () => {
      const { adaptQuery } = require('../src/services/query-adapter');
      const ctx = makeCtx({ handler: 'api::order.order.find' });
      return middleware(ctx, async () => {
        expect(adaptQuery(ctx.query).filters).toEqual({
          $and: [{ $or: [{ owner: { id: ME } }, { contact: { id: { $in: [MY_CONTACT] } } }] }],
        });
      });
    });

    it('matches no row when she has no contact, instead of dropping the filter', async () => {
      setup({ ...options(), contacts: {} });
      const ctx = await expectAllowed('api::received-income.received-income.findBasic');
      expect(ctx.query._where).toEqual({ _and: [{ 'contact.id_in': [-1] }] });
    });

    // issues/155 (2026-10-18): «Facturar» creates the drafts, and the member saw
    // them («Esborrany») in her «Factures» right away, before the office
    // checked and issued them.
    it('leaves the draft invoices out of her «Factures» (issues/155)', async () => {
      const ctx = await expectAllowed('api::emitted-invoice.emitted-invoice.findBasic', {
        query: { _where: { 'emitted_gte': '2026-01-01' } },
      });
      const { adaptQuery } = require('../src/services/query-adapter');
      expect(adaptQuery(ctx.query).filters).toEqual({
        $and: [
          {
            $and: [
              { contact: { id: { $in: [MY_CONTACT] } } },
              { $or: [{ state: { $ne: 'draft' } }, { state: { $null: true } }] },
            ],
          },
          { emitted: { $gte: '2026-01-01' } },
        ],
      });
    });

    it("refuses reading or changing another member's order", async () => {
      await expectAllowed('api::order.order.findOne', { numericId: 1 });
      await expectRefused('api::order.order.findOne', { numericId: 2 });
      await expectRefused('api::order.order.update', {
        method: 'PUT',
        numericId: 2,
        body: { data: { status: 'pending' } },
      });
    });

    it('lets her change her own order but not give it to someone else', async () => {
      await expectAllowed('api::order.order.update', {
        method: 'PUT',
        numericId: 1,
        body: { data: { status: 'cancelled', owner: ME } },
      });
      await expectRefused('api::order.order.update', {
        method: 'PUT',
        numericId: 1,
        body: { data: { owner: { id: OTHER } } },
      });
    });

    // issues/144 (2026-10-18): the Comandes selection bar offered «Pendent» to
    // members and the API didn't look at the order's status, so a member could
    // bulk-reset processed, delivered or invoiced orders to Pendent. She may
    // only cancel her own pending orders (what the order form lets her do).
    describe('state changes (issues/144)', () => {
      const put = (numericId, data) => ({ method: 'PUT', numericId, body: { data } });

      it('cancels her own pending order', async () => {
        await expectAllowed('api::order.order.update', put(1, { status: 'cancelled' }));
      });

      it('saves her pending order with its status unchanged', async () => {
        await expectAllowed('api::order.order.update', put(1, { status: 'pending', units: 3 }));
      });

      it.each([
        [5, 'pending'],
        [6, 'pending'],
        [13, 'pending'],
        [14, 'pending'],
        [5, 'cancelled'],
        [13, 'delivered'],
      ])('refuses moving order %s to %s', async (id, status) => {
        await expectRefused('api::order.order.update', put(id, { status }));
      });

      it.each([['processed'], ['delivered'], ['invoiced']])(
        'refuses setting her pending order to %s',
        async (status) => {
          await expectRefused('api::order.order.update', put(1, { status }));
        },
      );

      it('still adds incidences to a processed order of hers', async () => {
        await expectAllowed('api::order.order.update', put(5, { incidences: [1] }));
      });
    });

    it('on an order delivered to her pickup point, she only marks what was picked up', async () => {
      await expectAllowed('api::order.order.update', {
        method: 'PUT',
        numericId: 3,
        body: { data: { lines: [{ picked_up: true }], picked_up: true } },
      });
      await expectRefused('api::order.order.update', {
        method: 'PUT',
        numericId: 3,
        body: { data: { price: 0 } },
      });
    });

    it('creates orders and order imports as herself', async () => {
      const ctx = await expectAllowed('api::order.order.create', {
        method: 'POST',
        body: { data: { units: 1 } },
      });
      expect(ctx.request.body.data.owner).toBe(ME);
      await expectRefused('api::order.order.create', { method: 'POST', body: { data: { owner: OTHER } } });
      const csv = await expectAllowed('api::order.order.createCSV', {
        method: 'POST',
        body: { owner: { id: ME } },
      });
      expect(csv.request.body.owner).toEqual({ id: ME });
      await expectRefused('api::order.order.createCSV', { method: 'POST', body: { owner: { id: OTHER } } });
      const imp = await expectAllowed('api::orders-import.orders-import.create', {
        method: 'POST',
        body: { data: { users_permissions_user: OTHER } },
      });
      expect(imp.request.body.data.users_permissions_user).toBe(ME);
    });

    it("prints only her orders' delivery notes", async () => {
      await expectAllowed('api::order.order.pdfmultiple', { method: 'POST', body: { orders: [1, 3] } });
      await expectRefused('api::order.order.pdfmultiple', { method: 'POST', body: { orders: [1, 2] } });
    });

    // issues/372: only the date range of «Rutes i dies» reaches other members' rows
    const ROUTE_DAYS = { _where: { estimated_delivery_date_gte: '2026-10-19', estimated_delivery_date_lte: '2026-10-25' }, _limit: '-1' };

    it("keeps the route-day counts but not the other members' order details", async () => {
      const ctx = makeCtx({ handler: 'api::order.order.table', query: { ...ROUTE_DAYS } });
      await run(ctx);
      expect(ctx.query).toEqual(ROUTE_DAYS);
    });

    it.each([
      ['a filter on another field', { _where: { id: 24886, price_gt: 30 } }],
      ['a sort', { ...ROUTE_DAYS, _sort: 'price:DESC' }],
      ['an owner filter', { _where: { owner: OTHER } }],
      ['no filter', {}],
    ])('narrows orders/table to her orders with %s (issues/372)', async (_label, query) => {
      const ctx = makeCtx({ handler: 'api::order.order.table', query });
      await run(ctx);
      expect(ctx.query._where._and[0]).toEqual({ _or: [{ 'owner.id': ME }, { 'contact.id_in': [MY_CONTACT] }] });
    });

    it("cuts other members' rows that come back on the route-day query", async () => {
      const ctx = makeCtx({ handler: 'api::order.order.table', query: { ...ROUTE_DAYS } });
      await run(ctx, [
        {
          id: 1,
          ...ORDER(ME, 8),
          status: 'pending',
          estimated_delivery_date: '2026-10-20',
          route: { id: 3, name: 'R' },
          units: 2,
        },
        {
          id: 2,
          ...ORDER(OTHER, 8),
          status: 'pending',
          estimated_delivery_date: '2026-10-20',
          route: { id: 3, name: 'R' },
          units: 5,
          contact_name: 'Client',
        },
      ]);
      expect(ctx.body[0].units).toBe(2);
      expect(ctx.body[1]).toEqual({
        id: 2,
        status: 'pending',
        estimated_delivery_date: '2026-10-20',
        route: { id: 3 },
      });
    });

    it('narrows incidences to the ones of her orders', async () => {
      const ctx = await expectAllowed('api::incidence.incidence.find', {
        query: { 'order.owner': String(OTHER) },
      });
      expect(ctx.query._where._and[0]).toEqual({
        _or: [{ 'order.owner.id': ME }, { 'order.contact.id_in': [MY_CONTACT] }],
      });
      await expectAllowed('api::incidence.incidence.update', {
        method: 'PUT',
        numericId: 50,
        body: { data: { state: 'closed' } },
      });
      await expectRefused('api::incidence.incidence.update', {
        method: 'PUT',
        numericId: 51,
        body: { data: { state: 'closed' } },
      });
      await expectRefused('api::incidence.incidence.delete', { method: 'DELETE', numericId: 51 });
    });

    it("changes the contacts she sees on «Punts d'entrega» only", async () => {
      // hers, her own contact, a shared one
      for (const id of [10, MY_CONTACT, 9]) {
        await expectAllowed('api::contact.contact.update', {
          method: 'PUT',
          numericId: id,
          body: { data: { phone: '1' } },
        });
      }
      // another member's delivery point (issues/099: PUT /api/contacts/2239),
      // also when an order of hers goes to it (issues/187, review 5)
      for (const id of [12, 11]) {
        await expectRefused('api::contact.contact.update', {
          method: 'PUT',
          numericId: id,
          body: { data: { phone: '1' } },
        });
      }
      // the form sends her as owner; handing it to someone else is refused
      await expectAllowed('api::contact.contact.update', {
        method: 'PUT',
        numericId: 10,
        body: { data: { owner: ME } },
      });
      await expectRefused('api::contact.contact.update', {
        method: 'PUT',
        numericId: 10,
        body: { data: { owner: OTHER } },
      });
      await expectRefused('api::contact.contact.update', {
        method: 'PUT',
        numericId: 10,
        body: { data: { users_permissions_user: ME } },
      });
    });

    it('creates contacts as their owner', async () => {
      const ctx = await expectAllowed('api::contact.contact.create', {
        method: 'POST',
        body: { data: { name: 'X' } },
      });
      expect(ctx.request.body.data.owner).toBe(ME);
      await expectRefused('api::contact.contact.create', {
        method: 'POST',
        body: { data: { owner: OTHER } },
      });
    });
  });

  // issues/163-166 (redesign review 2026-10-18): the actions were checked, not
  // what they wrote or returned. A member set the price of her orders and
  // unlinked them from their invoice, a driver changed any field of any order,
  // a member rewrote shared points and the office's incidence replies, a
  // worker renamed the Tresoreria pivot views, and populate gave salaries.
  describe('what members and drivers write on an order (issues/163)', () => {
    const options = () => ({
      permissions: { [ME]: ['orders'], [OTHER]: ['orders_delivery'], 300: ['orders', 'orders_delivery'] },
      contacts: {
        8: { id: 8, owner: { id: ME }, users_permissions_user: null, pickup_discount: 10 },
      },
      orders: {
        1: { id: 1, status: 'pending', ...ORDER(ME, 8) },
        5: { id: 5, status: 'processed', ...ORDER(ME, 8) },
        13: { id: 13, status: 'invoiced', ...ORDER(ME, 8) },
        20: { id: 20, status: 'pending', ...ORDER(300, 8) },
      },
    });
    beforeEach(() => setup(options()));
    const put = (numericId, data, userId = ME) => ({ method: 'PUT', numericId, userId, body: { data } });

    it("drops the office's fields from her pending order and leaves the price to the server", async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(1, {
          kilograms: 12,
          price: 0.5,
          multidelivery_discount: 90,
          contact_pickup_discount: 100,
          emitted_invoice: null,
          transfer_start_date: '2026-10-18',
          pickup_date: '2026-10-18',
        }),
      );
      expect(ctx.request.body.data).toEqual({ kilograms: 12, price: null, route_rate: null });
    });

    // issues/315: a member can't take off her late surcharge nor mark herself late
    it('drops the late flags and the surcharge from her order', async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(1, { comments: 'x', late_order: false, late_surcharge: 0, late_pickup: false }),
      );
      expect(ctx.request.body.data).toEqual({ comments: 'x' });
    });

    it('keeps the stored price when nothing it depends on changes', async () => {
      const ctx = await expectAllowed('api::order.order.update', put(1, { comments: 'x', price: 0.5 }));
      expect(ctx.request.body.data).toEqual({ comments: 'x' });
    });

    it('takes the pickup discount from the delivery point, not from her', async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(1, { contact: 8, contact_pickup_discount: 100 }),
      );
      expect(ctx.request.body.data.contact_pickup_discount).toBe(10);
    });

    it('does not let her unlink or reprice an invoiced order', async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(13, { price: 0.5, emitted_invoice: null, status: 'invoiced' }),
      );
      expect(ctx.request.body.data).toEqual({ status: 'invoiced' });
    });

    it('records her deposit in her name', async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(5, { deposit_date: '2026-10-18T10:00:00Z', deposit_user: OTHER }),
      );
      expect(ctx.request.body.data).toEqual({ deposit_date: '2026-10-18T10:00:00Z', deposit_user: ME });
    });

    it('creates her orders pending, without price or invoice', async () => {
      const ctx = await expectAllowed('api::order.order.create', {
        method: 'POST',
        body: { data: { status: 'invoiced', price: 0.01, emitted_invoice: 4, kilograms: 3 } },
      });
      expect(ctx.request.body.data).toEqual({ status: 'pending', owner: ME, kilograms: 3, price: null, route_rate: null });
    });

    it("cleans the CSV import's orders and new points the same way", async () => {
      const ctx = await expectAllowed('api::order.order.createCSV', {
        method: 'POST',
        body: {
          price: 0.01,
          volume_discount: 5,
          kilograms: 3,
          contact: { name: 'Nou', pickup_discount: 80, partner_amount: 9 },
        },
      });
      expect(ctx.request.body).toEqual({
        kilograms: 3,
        price: null,
        route_rate: null,
        contact: { name: 'Nou' },
        owner: { id: ME },
        status: 'pending',
      });
    });

    it('a driver changes only the moves and the state of an order', async () => {
      const ctx = await expectAllowed(
        'api::order.order.update',
        put(5, { transfer_start_date: '2026-10-18T10:00:00Z', transfer_start_user: ME }, OTHER),
      );
      // in her name, whoever the screen said
      expect(ctx.request.body.data).toEqual({
        transfer_start_date: '2026-10-18T10:00:00Z',
        transfer_start_user: OTHER,
      });
      await expectAllowed(
        'api::order.order.update',
        put(5, { status: 'delivered', _tracking_user: { id: OTHER } }, OTHER),
      );
      await expectAllowed('api::order.order.update', put(5, { incidences: [{ description: 'x' }] }, OTHER));
      await expectRefused('api::order.order.update', put(5, { price: 0.5 }, OTHER));
      await expectRefused('api::order.order.update', put(5, { status: 'invoiced' }, OTHER));
      await expectRefused('api::order.order.update', put(13, { status: 'delivered' }, OTHER));
    });

    it('a driver does not create orders, unless she is a member too (then as one)', async () => {
      await expectRefused('api::order.order.create', { method: 'POST', userId: OTHER, body: { data: {} } });
      await expectRefused('api::order.order.createCSV', { method: 'POST', userId: OTHER, body: {} });
      const ctx = await expectAllowed('api::order.order.create', {
        method: 'POST',
        userId: 300,
        body: { data: { price: 1 } },
      });
      expect(ctx.request.body.data).toEqual({ owner: 300, status: 'pending', price: null, route_rate: null });
      // her own pending order, as a member
      const own = await expectAllowed('api::order.order.update', put(20, { units: 2, price: 1 }, 300));
      expect(own.request.body.data).toEqual({ units: 2 });
    });
  });

  describe('what a member writes on contacts and incidences (issues/164)', () => {
    const options = () => ({
      permissions: { [ME]: ['orders'] },
      contacts: {
        [MY_CONTACT]: { id: MY_CONTACT, users_permissions_user: { id: ME }, owner: null },
        9: { id: 9, owner: { id: OTHER }, users_permissions_user: null, multiowner: true },
        10: { id: 10, owner: { id: ME }, users_permissions_user: null },
      },
      orders: {
        1: { id: 1, status: 'delivered', ...ORDER(ME, 10) },
        2: { id: 2, status: 'pending', ...ORDER(OTHER, MY_CONTACT) },
      },
      incidences: {
        50: { id: 50, order: { id: 1 }, state: 'open', createdAt: new Date().toISOString() },
        52: { id: 52, order: { id: 1 }, state: 'closed', createdAt: new Date().toISOString() },
        53: { id: 53, order: { id: 1 }, state: 'open', createdAt: '2026-01-01T00:00:00Z' },
        54: { id: 54, order: { id: 2 }, state: 'open', createdAt: new Date().toISOString() },
      },
    });
    beforeEach(() => setup(options()));
    const put = (numericId, data) => ({ method: 'PUT', numericId, body: { data } });

    it("keeps her point's address and contact fields, not the discounts nor the partner data", async () => {
      const ctx = await expectAllowed(
        'api::contact.contact.update',
        put(10, {
          address: 'C/ Nou',
          trade_name: 'Botiga',
          pickup_discount: 50,
          pickup_point: true,
          partner_amount: 99999,
          multidelivery: true,
          notes_delivery: 'x',
        }),
      );
      expect(ctx.request.body.data).toEqual({ address: 'C/ Nou', trade_name: 'Botiga' });
    });

    it('changes only the address of a shared point', async () => {
      const ctx = await expectAllowed(
        'api::contact.contact.update',
        put(9, { address: 'C/ Nou', name: 'Una altra', nif: 'B1' }),
      );
      expect(ctx.request.body.data).toEqual({ address: 'C/ Nou' });
    });

    it("creates points without the office's fields", async () => {
      const ctx = await expectAllowed('api::contact.contact.create', {
        method: 'POST',
        body: { data: { name: 'X', contact_types: [4], multiowner: true, pickup_discount: 50 } },
      });
      expect(ctx.request.body.data).toEqual({ name: 'X', contact_types: [4], owner: ME });
    });

    it('deletes an incidence of her order only while it is open and less than a day old', async () => {
      await expectAllowed('api::incidence.incidence.delete', { method: 'DELETE', numericId: 50 });
      await expectRefused('api::incidence.incidence.delete', { method: 'DELETE', numericId: 52 });
      await expectRefused('api::incidence.incidence.delete', { method: 'DELETE', numericId: 53 });
      // an order delivered to her pickup point, not hers
      await expectRefused('api::incidence.incidence.delete', { method: 'DELETE', numericId: 54 });
    });
  });

  // issues/190 (review 4, 2026-10-19): a member moved the incidence of her
  // order onto another member's order (`{order: 24651}`) and set who opened
  // and closed it; issues/191: a driver set any point's pickup discount (it
  // feeds the order prices) and made points hers (`{owner: <her id>}`).
  describe('incidence fields and drivers on delivery points (issues/190, 191)', () => {
    const DRIVER = 300;
    const OFFICE = 400;
    const options = () => ({
      permissions: { [ME]: ['orders'], [DRIVER]: ['orders_delivery', 'hours'], [OFFICE]: ['orders_admin'] },
      contacts: {
        [MY_CONTACT]: { id: MY_CONTACT, users_permissions_user: { id: ME }, owner: null },
        10: { id: 10, owner: { id: ME, documentId: 'me-doc' }, users_permissions_user: null },
        11: { id: 11, owner: null, users_permissions_user: null },
      },
      orders: {
        1: { id: 1, status: 'delivered', ...ORDER(ME, 10) },
        2: { id: 2, status: 'pending', ...ORDER(OTHER, 11) },
      },
      incidences: {
        50: { id: 50, order: { id: 1 }, state: 'open' },
        51: { id: 51, order: { id: 1 }, state: 'closed' },
      },
    });
    beforeEach(() => setup(options()));
    const put = (numericId, data, userId = ME) => ({ method: 'PUT', numericId, userId, body: { data } });

    it("keeps a member's incidence on its order, with the server's opened and closed by", async () => {
      const ctx = await expectAllowed(
        'api::incidence.incidence.update',
        put(50, { order: 2, created_user: OTHER, closed_user: OTHER, closed_date: '2020-01-01', description: 'x' }),
      );
      expect(ctx.request.body.data).toEqual({ description: 'x' });
    });

    it('records the closing in the name of whoever closes it, and clears it on reopening', async () => {
      const closed = await expectAllowed(
        'api::incidence.incidence.update',
        put(50, { state: 'closed', closed_user: OTHER, closed_date: '2020-01-01' }),
      );
      expect(closed.request.body.data).toMatchObject({ state: 'closed', closed_user: ME });
      expect(closed.request.body.data.closed_date).toBeInstanceOf(Date);
      const reopened = await expectAllowed('api::incidence.incidence.update', put(51, { state: 'wip' }));
      expect(reopened.request.body.data).toEqual({ state: 'wip', closed_date: null, closed_user: null });
    });

    it.each([[DRIVER], [OFFICE]])('limits the logistics staff (%s) to the same fields', async (userId) => {
      const ctx = await expectAllowed(
        'api::incidence.incidence.update',
        put(50, { order: 2, created_user: ME, state: 'closed', incidence_response: [] }, userId),
      );
      expect(ctx.request.body.data).toMatchObject({ state: 'closed', incidence_response: [], closed_user: userId });
      expect(ctx.request.body.data).not.toHaveProperty('order');
      expect(ctx.request.body.data).not.toHaveProperty('created_user');
    });

    it("lets a driver change a point like the office, but not its discount nor its owner", async () => {
      const ctx = await expectAllowed(
        'api::contact.contact.update',
        put(10, { address: 'C/ Nou', notes_delivery: 'x', pickup_point: true, pickup_discount: 70, owner: ME }, DRIVER),
      );
      expect(ctx.request.body.data).toEqual({ address: 'C/ Nou', notes_delivery: 'x', pickup_point: true, owner: ME });
      await expectAllowed('api::contact.contact.update', put(10, { owner: { id: ME } }, DRIVER));
      await expectAllowed('api::contact.contact.update', put(11, { owner: null }, DRIVER));
      await expectRefused('api::contact.contact.update', put(10, { owner: DRIVER }, DRIVER));
      await expectRefused('api::contact.contact.update', put(11, { owner: DRIVER }, DRIVER));
    });

    it('creates the points of a driver without pickup discount', async () => {
      const ctx = await expectAllowed('api::contact.contact.create', {
        method: 'POST',
        userId: DRIVER,
        body: { data: { name: 'Botiga', owner: ME, pickup_discount: 70 } },
      });
      expect(ctx.request.body.data).toEqual({ name: 'Botiga', owner: ME });
    });

    it('leaves the office the discount and the owner', async () => {
      const ctx = await expectAllowed('api::contact.contact.update', put(10, { pickup_discount: 70, owner: OFFICE }, OFFICE));
      expect(ctx.request.body.data).toEqual({ pickup_discount: 70, owner: OFFICE });
    });
  });

  describe('populate and broad reads (issues/165)', () => {
    const USER = 'plugin::users-permissions.user';
    const contentTypes = {
      [USER]: {
        attributes: {
          daily_dedications: { type: 'relation', target: 'api::daily-dedication.daily-dedication' },
        },
      },
      'api::daily-dedication.daily-dedication': { attributes: {} },
      'api::task.task': {
        attributes: {
          project: { type: 'relation', target: 'api::project.project' },
          users_permissions_users: { type: 'relation', target: USER },
        },
      },
      'api::project.project': {
        attributes: {
          received_invoices: { type: 'relation', target: 'api::received-invoice.received-invoice' },
        },
      },
      'api::contact.contact': { attributes: {} },
    };
    const someone = () => ({
      id: 3,
      username: 'anna',
      fullname: 'Anna',
      email: 'anna@example.org',
      ical: 'https://calendar.google.com/secret',
      identity_number: '1',
      naf: '2',
      monthly_salary: 2000,
      daily_dedications: [{ id: 1, monthly_salary: 2000 }],
      permissions: [{ permission: 'hours' }],
    });

    it('a worker gets the people without salary, identity nor calendar', async () => {
      setup({ permissions: { [ME]: ['hours'] }, contentTypes });
      const ctx = makeCtx({ handler: 'user.find', info: { pluginName: 'users-permissions' } });
      await run(ctx, [someone()]);
      expect(ctx.body).toEqual([
        {
          id: 3,
          username: 'anna',
          fullname: 'Anna',
          email: 'anna@example.org',
          permissions: [{ permission: 'hours' }],
        },
      ]);
    });

    it('her own row keeps her calendar and identity (Hores dedicades, Registre jornades), not the salary', async () => {
      setup({ permissions: { [ME]: ['hours'] }, contentTypes });
      const ctx = makeCtx({ handler: 'user.find', info: { pluginName: 'users-permissions' } });
      await run(ctx, [{ ...someone(), id: ME }]);
      expect(ctx.body[0]).toMatchObject({ ical: 'https://calendar.google.com/secret', identity_number: '1', naf: '2' });
      expect(ctx.body[0].monthly_salary).toBeUndefined();
      expect(ctx.body[0].daily_dedications).toEqual([{ id: 1 }]);
    });

    it("a member gets only the people's names", async () => {
      setup({ permissions: { [ME]: ['orders'] }, contentTypes });
      const ctx = makeCtx({ handler: 'user.findOne', info: { pluginName: 'users-permissions' } });
      await run(ctx, someone());
      expect(ctx.body).toEqual({ id: 3, username: 'anna', fullname: 'Anna' });
    });

    it("a populated task brings neither the project's finances nor salaries", async () => {
      setup({ permissions: { [ME]: ['hours'] }, contentTypes });
      const ctx = makeCtx({ handler: 'api::task.task.find' });
      await run(ctx, {
        data: [
          {
            id: 1,
            name: 'Tasca',
            project: {
              id: 2,
              name: 'P',
              balance: 5,
              total_real_incomes: 9,
              total_real_hours: 30,
              received_invoices: [{ id: 4 }],
            },
            users_permissions_users: [someone()],
          },
        ],
        meta: {},
      });
      expect(ctx.body.data[0].project).toEqual({ id: 2, name: 'P', total_real_hours: 30 });
      expect(ctx.body.data[0].users_permissions_users[0].daily_dedications).toBeUndefined();
      expect(ctx.body.data[0].users_permissions_users[0].monthly_salary).toBeUndefined();
    });

    it("leaves the full-access users' responses alone", async () => {
      setup({ permissions: { [ME]: ['projects'] }, contentTypes });
      const ctx = makeCtx({ handler: 'user.find', info: { pluginName: 'users-permissions' } });
      await run(ctx, [someone()]);
      expect(ctx.body[0].monthly_salary).toBe(2000);
    });

    it("narrows a member's contacts to the ones of «Punts d'entrega»", async () => {
      setup({
        permissions: { [ME]: ['orders'] },
        contacts: {
          [MY_CONTACT]: { id: MY_CONTACT, users_permissions_user: { id: ME } },
          12: { id: 12, owner: { id: OTHER }, users_permissions_user: null },
        },
        orders: { 1: { id: 1, ...ORDER(ME, 8) } },
        contentTypes,
      });
      const ctx = await expectAllowed('api::contact.contact.basic', { query: { _limit: '-1' } });
      const { adaptQuery } = require('../src/services/query-adapter');
      expect(adaptQuery(ctx.query).filters).toEqual({
        $and: [
          {
            $or: [
              { owner: { id: ME } },
              { users_permissions_user: { id: ME } },
              { multiowner: true },
              { multidelivery: true },
            ],
          },
        ],
      });
      // another member's delivery point: members see every one (issues/187, DECIDED)
      await expectAllowed('api::contact.contact.findOne', { numericId: 12 });
      await expectAllowed('api::contact.contact.findOne', { numericId: MY_CONTACT });
    });

    it('drops the office data of the contacts a member reads', async () => {
      setup({ permissions: { [ME]: ['orders'] }, contentTypes });
      const ctx = makeCtx({ handler: 'api::contact.contact.basic' });
      await run(ctx, [{ id: 8, name: 'Botiga', partner_amount: 300, notes: 'n' }]);
      expect(ctx.body).toEqual([{ id: 8, name: 'Botiga', notes: 'n' }]);
    });

    it('a worker gets only the names of the contacts', async () => {
      setup({ permissions: { [ME]: ['hours'] }, contentTypes });
      const ctx = makeCtx({ handler: 'api::contact.contact.basic' });
      await run(ctx, [
        { id: 8, name: 'Botiga', trade_name: 'B', nif: 'B1', email: 'a@b.c', partner_amount: 3 },
      ]);
      expect(ctx.body).toEqual([{ id: 8, name: 'Botiga', trade_name: 'B' }]);
    });
  });

  describe('saved pivot views (issues/166)', () => {
    const PIVOT = 'api::pivot-table-view.pivot-table-view';
    const options = () => ({
      permissions: { [ME]: ['hours'] },
      rows: {
        [PIVOT]: {
          4: { id: 4, identifier: 'dedication-est-pivot' },
          5: { id: 5, identifier: 'tresoreria-pivot' },
        },
      },
    });
    beforeEach(() => setup(options()));

    it('lists only the views of her screens', async () => {
      const ctx = await expectAllowed(`${PIVOT}.find`, { query: { identifier: 'tresoreria-pivot' } });
      expect(ctx.query._where._and[0]).toEqual({
        identifier_in: ['dedication-pivot', 'dedication-est-pivot'],
      });
    });

    it('changes and deletes only those', async () => {
      await expectAllowed(`${PIVOT}.update`, { method: 'PUT', numericId: 4, body: { data: { name: 'x' } } });
      await expectRefused(`${PIVOT}.update`, { method: 'PUT', numericId: 5, body: { data: { name: 'x' } } });
      await expectRefused(`${PIVOT}.delete`, { method: 'DELETE', numericId: 5 });
      await expectRefused(`${PIVOT}.update`, {
        method: 'PUT',
        numericId: 4,
        body: { data: { identifier: 'tresoreria-pivot' } },
      });
    });

    it('creates views only for her screens', async () => {
      await expectAllowed(`${PIVOT}.create`, {
        method: 'POST',
        body: { data: { identifier: 'dedication-est-pivot' } },
      });
      await expectRefused(`${PIVOT}.create`, {
        method: 'POST',
        body: { data: { identifier: 'tresoreria-pivot' } },
      });
    });
  });

  describe('route registration', () => {
    it('names actions the way the role permissions do', () => {
      jest.resetModules();
      const { actionOf } = require('../src/middlewares/app-permissions');
      expect(actionOf({ handler: 'api::order.order.find', info: { apiName: 'order' } })).toBe(
        'api::order.order.find',
      );
      expect(actionOf({ handler: 'order.table', info: { apiName: 'order' } })).toBe('api::order.order.table');
      expect(actionOf({ handler: 'user.me', info: { pluginName: 'users-permissions' } })).toBe(
        'plugin::users-permissions.user.me',
      );
      expect(actionOf({ handler: 'content-api.upload', info: { pluginName: 'upload' } })).toBe(
        'plugin::upload.content-api.upload',
      );
    });

    it('adds the middleware to API and plugin content-API routes, not to admin routes', () => {
      jest.resetModules();
      const { registerAppPermissions } = require('../src/services/register-app-permissions');
      const core = {
        routes: [{ handler: 'api::order.order.find', config: { policies: ['global::isAdmin'] } }],
      };
      const custom = () => ({ routes: [{ handler: 'order.table' }] });
      const upContent = { type: 'content-api', routes: [{ handler: 'user.me' }] };
      const upAdmin = { type: 'admin', routes: [{ handler: 'role.find' }] };
      const apis = { order: { routes: { order: core, '01-custom-order': custom } } };
      const fake = {
        apis,
        api: (name) => apis[name],
        plugins: { 'users-permissions': { routes: { 'content-api': () => upContent, admin: upAdmin } } },
      };
      expect(registerAppPermissions(fake)).toBe(3);
      expect(core.routes[0].config).toEqual({
        policies: ['global::isAdmin'],
        middlewares: ['global::app-permissions'],
      });
      expect(apis.order.routes['01-custom-order'].routes[0].config.middlewares).toEqual([
        'global::app-permissions',
      ]);
      expect(upContent.routes[0].config.middlewares).toEqual(['global::app-permissions']);
      expect(upAdmin.routes[0].config).toBeUndefined();
      // idempotent
      registerAppPermissions(fake);
      expect(core.routes[0].config.middlewares).toEqual(['global::app-permissions']);
    });
  });
});
