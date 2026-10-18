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

function makeStrapi({ permissions, orders = {}, contacts = {}, incidences = {}, rows = {} }) {
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
  return { db: { query: jest.fn(query) } };
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
        'api::contact.contact.orders',
        'api::contact.contact.delete',
        'api::pivot-table-view.pivot-table-view.create',
        'api::me.me.dir3SearchNif',
      ]) {
        await expectAllowed(handler);
      }
      await expectRefused('api::payroll.payroll.find');
      await expectRefused('api::project.project.update');
      await expectRefused('api::emitted-invoice.emitted-invoice.update');
    });

    it('orders_delivery marks orders but does not invoice them', async () => {
      setup({ permissions: { [ME]: ['orders_delivery'] } });
      await expectAllowed('api::order.order.update', {
        method: 'PUT',
        body: { data: { owner: OTHER } },
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
        1: { id: 1, ...ORDER(ME, 8) },
        2: { id: 2, ...ORDER(OTHER, 8) },
        3: { id: 3, ...ORDER(OTHER, MY_CONTACT) },
        4: { id: 4, ...ORDER(ME, 11) },
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
      const ctx = await expectAllowed('api::emitted-invoice.emitted-invoice.findBasic');
      expect(ctx.query._where).toEqual({ _and: [{ 'contact.id_in': [-1] }] });
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

    it("keeps the route-day counts but not the other members' order details", async () => {
      const ctx = makeCtx({ handler: 'api::order.order.table' });
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
      // hers, her own contact, a shared one, one her orders go to
      for (const id of [10, MY_CONTACT, 9, 11]) {
        await expectAllowed('api::contact.contact.update', {
          method: 'PUT',
          numericId: id,
          body: { data: { phone: '1' } },
        });
      }
      // another member's delivery point (issues/099: PUT /api/contacts/2239)
      await expectRefused('api::contact.contact.update', {
        method: 'PUT',
        numericId: 12,
        body: { data: { phone: '1' } },
      });
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
