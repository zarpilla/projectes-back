'use strict';

/**
 * issues/357 (Joel, la Diligència, 2026-11-10): a member asks for a delivery
 * point the service doesn't cover yet from a tab next to the Simulador,
 * «Consulta i autorització nou punt d'entrega». Nom comercial, Població,
 * Adreça, Horari (free text), Pes estimat, Notes; only Població, Adreça and
 * Horari required. ESSTrapís mails it to the office (the incidences' address)
 * and keeps it on a list: who asked, when, and a switch «resposta».
 */

const fs = require('fs');
const path = require('path');

const UID = 'api::delivery-point-request.delivery-point-request';

function loadController({ permissions = {}, rows = {} } = {}) {
  jest.resetModules();
  const base = {
    find: jest.fn(async (ctx) => ({ data: [], query: ctx.query })),
    findOne: jest.fn(async () => ({ data: { id: 1 } })),
    create: jest.fn(async (ctx) => ({ data: ctx.request.body.data })),
    update: jest.fn(async (ctx) => ({ data: ctx.request.body.data })),
  };
  global.strapi = {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    db: {
      query: (uid) => ({
        findOne: async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') {
            return { id: where.id, permissions: (permissions[where.id] || []).map((permission) => ({ permission })) };
          }
          return rows[where.id] || null;
        },
      }),
    },
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base) },
  }));
  return { ctrl: require('../src/api/delivery-point-request/controllers/delivery-point-request'), base };
}

const ctx = (data, userId = 5, extra = {}) => ({
  request: { body: { data } },
  query: {},
  params: {},
  state: { user: { id: userId } },
  badRequest: (m) => ({ refused: m }),
  notFound: () => ({ notFound: true }),
  ...extra,
});

afterEach(() => {
  delete global.strapi;
});

describe('sending a request (issues/357)', () => {
  it('needs the town, the address and the schedule, nothing else', async () => {
    const { ctrl, base } = loadController();
    expect(await ctrl.create(ctx({ trade_name: 'Bar', city: 'Vic' }))).toEqual({ refused: "Falta l'adreça i l'horari." });
    expect(await ctrl.create(ctx({ city: ' ', address: 'C/ Major 1', schedule: 'Matins' }))).toEqual({ refused: 'Falta la població.' });
    await ctrl.create(ctx({ city: 'Vic', address: 'C/ Major 1', schedule: 'De dilluns a divendres, de 8 a 20 h' }));
    expect(base.create).toHaveBeenCalledTimes(1);
  });

  it('is in the name of who sends it, never answered, and keeps only its fields', async () => {
    const { ctrl } = loadController();
    const res = await ctrl.create(ctx({
      trade_name: 'Bar Nou', city: 'Vic', address: 'C/ Major 1', schedule: 'Matins', estimated_weight: '15 kg', notes: 'Porta lateral',
      user: 99, answered: true, answered_user: 99, answered_date: '2026-01-01',
    }, 5));
    expect(res.data).toEqual({
      trade_name: 'Bar Nou', city: 'Vic', address: 'C/ Major 1', schedule: 'Matins', estimated_weight: '15 kg', notes: 'Porta lateral',
      user: 5, answered: false,
    });
  });
});

describe('the list (issues/357)', () => {
  it('a member reads only her own requests', async () => {
    const { ctrl, base } = loadController({ permissions: { 5: ['orders'] } });
    await ctrl.find(ctx(undefined, 5));
    expect(base.find.mock.calls[0][0].query.filters).toEqual({ $and: [{}, { user: { id: 5 } }] });
  });

  it('the office and admins read them all', async () => {
    for (const perms of [['orders_admin'], ['admin'], ['projects']]) {
      const { ctrl, base } = loadController({ permissions: { 2: perms } });
      await ctrl.find(ctx(undefined, 2));
      expect(base.find.mock.calls[0][0].query.filters).toBeUndefined();
    }
  });

  it("a member can't open another member's request", async () => {
    const { ctrl, base } = loadController({ permissions: { 5: ['orders'] }, rows: { 8: { id: 8, user: { id: 6 } }, 9: { id: 9, user: { id: 5 } } } });
    expect(await ctrl.findOne(ctx(undefined, 5, { params: { id: '8' } }))).toEqual({ notFound: true });
    await ctrl.findOne(ctx(undefined, 5, { params: { id: '9' } }));
    expect(base.findOne).toHaveBeenCalledTimes(1);
  });
});

describe('approving or rejecting it (issues/357, seguiment)', () => {
  it('records the decision, who and when, and changes nothing the member sent', async () => {
    const { ctrl } = loadController({ rows: { 1: { id: 1, status: null } } });
    global.strapi.service = () => ({ sendDecisionEmail: async () => true });
    const res = await ctrl.update(ctx({ status: 'approved', answer: ' Hi passem els dimarts ', city: 'Manlleu', user: 1, answered: false }, 2, { params: { id: '1' } }));
    expect(res.data).toEqual({ status: 'approved', answered: true, answered_date: expect.any(Date), answered_user: 2, answer: 'Hi passem els dimarts' });
    const rejected = await ctrl.update(ctx({ status: 'rejected', answer: '' }, 2, { params: { id: '1' } }));
    expect(rejected.data).toMatchObject({ status: 'rejected', answered: true, answer: null });
    const back = await ctrl.update(ctx({ status: null }, 2, { params: { id: '1' } }));
    expect(back.data).toEqual({ status: null, answered: false, answered_date: null, answered_user: null });
    const unknown = await ctrl.update(ctx({ status: 'maybe' }, 2, { params: { id: '1' } }));
    expect(unknown.data).toMatchObject({ status: null, answered: false });
  });

  it('archiving or linking the point leaves the decision alone', () => {
    const { ctrl } = loadController();
    expect(ctrl.officeChanges({ archived: true }, 2)).toEqual({ archived: true });
    expect(ctrl.officeChanges({ archived: 'false' }, 2)).toEqual({ archived: false });
    expect(ctrl.officeChanges({ contact: 77 }, 2)).toEqual({ contact: 77 });
    expect(ctrl.officeChanges({ contact: { id: '77' } }, 2)).toEqual({ contact: 77 });
    expect(ctrl.officeChanges({ contact: null }, 2)).toEqual({ contact: null });
  });

  it('mails the member a new decision only', async () => {
    const { ctrl } = loadController({ rows: { 1: { id: 1, status: 'approved' }, 2: { id: 2, status: null } } });
    const sendDecisionEmail = jest.fn(async () => true);
    global.strapi.service = () => ({ sendDecisionEmail });
    await ctrl.update(ctx({ status: 'approved' }, 2, { params: { id: '1' } }));
    await ctrl.update(ctx({ archived: true }, 2, { params: { id: '2' } }));
    expect(sendDecisionEmail).not.toHaveBeenCalled();
    await ctrl.update(ctx({ status: 'rejected' }, 2, { params: { id: '1' } }));
    await ctrl.update(ctx({ status: 'approved' }, 2, { params: { id: '2' } }));
    expect(sendDecisionEmail.mock.calls).toEqual([[1], [2]]);
  });

  it('the office lists the archived ones apart; a member sees all hers', async () => {
    const office = loadController({ permissions: { 2: ['orders_admin'] } });
    await office.ctrl.find({ ...ctx(undefined, 2), query: { _archived: '0' } });
    expect(office.base.find.mock.calls[0][0].query.filters).toEqual({
      $and: [{}, { $or: [{ archived: { $eq: false } }, { archived: { $null: true } }] }],
    });
    await office.ctrl.find({ ...ctx(undefined, 2), query: { _archived: '1' } });
    expect(office.base.find.mock.calls[1][0].query.filters).toEqual({ $and: [{}, { archived: { $eq: true } }] });
    expect(office.base.find.mock.calls[1][0].query._archived).toBeUndefined();
    const member = loadController({ permissions: { 5: ['orders'] } });
    await member.ctrl.find({ ...ctx(undefined, 5), query: { _archived: '0' } });
    expect(member.base.find.mock.calls[0][0].query.filters).toEqual({ $and: [{}, { user: { id: 5 } }] });
  });

  it('only the office: route policy and app rules', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const p of ['orders', 'orders_delivery', 'orders_admin']) {
      expect(isAllowed(`${UID}.create`, [p])).toBe(true);
      expect(isAllowed(`${UID}.find`, [p])).toBe(true);
    }
    expect(isAllowed(`${UID}.create`, ['hours'])).toBe(false);
    for (const action of ['update', 'delete']) {
      expect(isAllowed(`${UID}.${action}`, ['orders_admin'])).toBe(true);
      expect(isAllowed(`${UID}.${action}`, ['orders'])).toBe(false);
      expect(isAllowed(`${UID}.${action}`, ['orders_delivery'])).toBe(false);
    }
    const routes = fs.readFileSync(path.join(__dirname, '../src/api/delivery-point-request/routes/delivery-point-request.js'), 'utf8');
    expect(routes).toMatch(/update: \{ policies: \['global::isAdminOrOffice'\] \}/);
    expect(routes).toMatch(/delete: \{ policies: \['global::isAdminOrOffice'\] \}/);
    const matrix = fs.readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    expect(matrix).toContain("'delivery-point-request': ['find', 'findOne', 'create', 'update', 'delete'],");
  });
});

describe('the mail of the decision to the member (issues/357, seguiment)', () => {
  function loadService(request, me = { name: 'La Diligència', contact_form_email: 'gestio@example.org, oficina@example.org' }) {
    jest.resetModules();
    const send = jest.fn(async () => {});
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => me, getFrontUrl: async () => 'https://app.example.org/' }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreService: (_uid, cfg) => cfg({ strapi: global.strapi }) } }));
    global.strapi = {
      log: { warn: jest.fn(), error: () => {} },
      config: { get: () => 'noreply@example.org' },
      plugin: () => ({ service: () => ({ send }) }),
      db: { query: () => ({ findOne: async () => request }) },
    };
    return { service: require('../src/api/delivery-point-request/services/delivery-point-request'), send };
  }

  it('tells the member, with the office message, and replies go to the office', async () => {
    const { service, send } = loadService({
      id: 3, status: 'approved', answer: 'Hi passem <b>dimarts</b>', trade_name: 'Bar Nou', address: 'C/ Major 1', city: 'Vic',
      user: { id: 5, email: 'serra@example.org' },
    });
    expect(await service.sendDecisionEmail(3)).toBe(true);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['serra@example.org']);
    expect(mail.replyTo).toBe('gestio@example.org, oficina@example.org');
    expect(mail.subject).toBe("[La Diligència] Consulta de nou punt d'entrega aprovada - Vic");
    expect(mail.html).toContain('(Bar Nou, C/ Major 1, Vic)');
    expect(mail.html).toContain('Hi passem &lt;b&gt;dimarts&lt;/b&gt;');
  });

  it('a rejection says so; no member e-mail, no mail', async () => {
    const rejected = loadService({ id: 3, status: 'rejected', city: 'Vic', user: { id: 5, email: 'serra@example.org' } });
    await rejected.service.sendDecisionEmail(3);
    expect(rejected.send.mock.calls[0][0].subject).toBe("[La Diligència] Consulta de nou punt d'entrega rebutjada - Vic");
    const noMail = loadService({ id: 3, status: 'approved', city: 'Vic', user: { id: 5 } });
    expect(await noMail.service.sendDecisionEmail(3)).toBe(false);
    expect(noMail.send).not.toHaveBeenCalled();
  });
});

describe('the mail to the office (issues/357)', () => {
  it('goes to the incidences address with a copy to the member, who gets the replies', async () => {
    jest.resetModules();
    const send = jest.fn(async () => {});
    jest.doMock('../src/services/me-settings', () => ({
      getMe: async () => ({ name: 'La Diligència', contact_form_email: 'gestio@example.org, oficina@example.org' }),
      getFrontUrl: async () => 'https://app.example.org/',
    }));
    global.strapi = {
      log: { warn: () => {}, error: () => {} },
      config: { get: () => 'noreply@example.org' },
      plugin: () => ({ service: () => ({ send }) }),
      db: { query: () => ({ findOne: async () => ({ id: 5, username: 'formatges', fullname: 'Formatges <b>Serra</b>', email: 'serra@example.org' }) }) },
    };
    const lifecycles = require('../src/api/delivery-point-request/content-types/delivery-point-request/lifecycles');
    await lifecycles.afterCreate({
      result: { id: 12 },
      params: { data: { user: 5, trade_name: 'Bar Nou', city: 'Vic', address: 'C/ Major 1', schedule: 'Matins\nTardes no', estimated_weight: '15 kg' } },
    });
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['gestio@example.org', 'oficina@example.org', 'serra@example.org']);
    expect(mail.replyTo).toBe('serra@example.org');
    expect(mail.subject).toBe("[La Diligència] Consulta de nou punt d'entrega - Vic");
    expect(mail.html).toContain('Formatges &lt;b&gt;Serra&lt;/b&gt;');
    expect(mail.html).toContain('<b>Horari:</b> Matins<br>Tardes no');
    expect(mail.html).toContain('https://app.example.org/consulta-punt-entrega');
  });

  it('is limited like the contact form', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/middlewares/app-permissions.js'), 'utf8');
    expect(source).toContain("if (action === 'api::delivery-point-request.delivery-point-request.create') countMails('pointRequest', userId, 1);");
  });
});
