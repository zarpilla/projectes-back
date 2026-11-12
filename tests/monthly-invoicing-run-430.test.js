'use strict';

/**
 * issues/430: the automatic monthly invoicing run, with a fake database. One
 * draft per member that can be invoiced, a notice in Avisos for the one that
 * can't, the report «FACTURACIÓ AUTOMÀTICA» to the office, the run recorded;
 * the cron leaves alone an entity without the option and a month already run.
 */

const UIDS = {
  project: 'api::project.project',
  order: 'api::order.order',
  run: 'api::auto-invoicing-run.auto-invoicing-run',
  notice: 'api::member-notice.member-notice',
  contact: 'api::contact.contact',
};

function setup({ projects, orders, runs = [], contacts }) {
  jest.resetModules();
  const written = { runs: [], runUpdates: [], notices: [], mails: [], groups: null };
  jest.doMock('../src/services/me-settings', () => ({
    getMe: async () => ({ name: 'La Diligència', contact_form_email: 'gestio@example.org', orders_options: {} }),
  }));
  jest.doMock('../src/api/order/services/order-invoices', () => ({
    orderLine: (o) => ({ concept: `Comanda ${o.id}`, base: o.price, quantity: 1 }),
    invoicingProject: async (id) => ({ project: { id }, phase: { id: 50 } }),
    createOrderInvoices: async (args) => {
      written.groups = args.groups;
      written.emitted = args.emitted;
      return args.groups.map((g, i) => ({ owner: g.owner, invoice: { id: 700 + i, total: 12.1 }, contactOrders: g.orders }));
    },
  }));
  const query = (uid) => ({
    findMany: async (args = {}) => {
      if (uid === UIDS.project) return projects;
      if (uid === UIDS.order) {
        // the month's expected orders (with a lower bound) or the candidates
        const where = args.where || {};
        const day = where.estimated_delivery_date || {};
        return orders.filter((o) => (!day.$gte || o.estimated_delivery_date >= day.$gte) && o.estimated_delivery_date <= day.$lte);
      }
      if (uid === 'api::serie.serie') return [{ id: 4, name: '2026' }];
      if (uid === UIDS.contact) return contacts;
      if (uid === UIDS.run) return runs;
      if (uid === 'api::payment-method.payment-method') return [{ id: 1 }];
      return [];
    },
    findOne: async ({ where }) => runs.find((r) => r.month === where.month && r.trigger === where.trigger) || null,
    count: async () => projects.filter((p) => p.auto_invoicing).length,
    create: async ({ data }) => {
      if (uid === UIDS.run) { written.runs.push(data); return { id: 1, ...data }; }
      if (uid === UIDS.notice) { written.notices.push(data); return data; }
      return data;
    },
    update: async ({ data }) => { written.runUpdates.push(data); return data; },
  });
  global.strapi = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { query },
    documents: () => ({ findFirst: async () => ({ mode: 'off' }) }),
    config: { get: () => 'noreply@example.org' },
    plugin: () => ({ service: () => ({ send: async (mail) => written.mails.push(mail) }) }),
  };
  return { monthly: require('../src/services/monthly-invoicing/run'), written };
}

afterEach(() => { delete global.strapi; });

const PROJECT = { id: 2, name: 'Logística T4 2026', auto_invoicing: true, date_start: '2026-10-01', date_end: '2026-12-31' };
const o = (id, ownerId, day, extra = {}) => ({ id, owner: { id: ownerId, username: `u${ownerId}` }, estimated_delivery_date: day, status: 'delivered', price: 10, ...extra });
const CONTACTS = [{ id: 11, name: 'Formatges', users_permissions_user: { id: 1 } }, { id: 12, name: 'Hortes', users_permissions_user: { id: 2 } }];

describe('the monthly run (issues/430)', () => {
  it('a draft per member, a notice for the blocked one, the report, the run recorded', async () => {
    const { monthly, written } = setup({
      projects: [PROJECT],
      contacts: CONTACTS,
      orders: [o(1, 1, '2026-10-05'), o(2, 1, '2026-09-20'), o(3, 2, '2026-10-08', { price: null }), o(4, 2, '2026-10-09')],
    });
    const report = await monthly.run({ month: '2026-10', trigger: 'cron' });

    expect(written.emitted).toBe('2026-10-31');
    expect(written.groups).toHaveLength(1);
    expect(written.groups[0]).toMatchObject({ owner: 1, contact: { id: 11 } });
    expect(written.groups[0].lines.map((l) => l.concept)).toEqual(['Comanda 1', 'Serveis pendents de setembre 2026 · Comanda 2']);

    expect(report).toMatchObject({ drafts: 1, blocked: 1, project: { id: 2 } });
    expect(report.reconciliation).toMatchObject({ ok: false, missing: { orders: [3, 4] } });

    expect(written.notices).toEqual([expect.objectContaining({
      user: 2, kind: 'auto-invoicing', title: "No s'ha pogut generar la factura d'octubre 2026", orders: [3],
    })]);
    expect(written.notices[0].text).toContain('Comandes sense preu: 0003');

    expect(written.mails).toHaveLength(1);
    expect(written.mails[0]).toMatchObject({ to: ['gestio@example.org'], subject: 'FACTURACIÓ AUTOMÀTICA - OCTUBRE 2026' });
    expect(written.mails[0].html).toContain('Sense esborrany');
    expect(written.mails[0].html).toContain('No quadra');

    expect(written.runs[0]).toMatchObject({ month: '2026-10', trigger: 'cron', status: 'running' });
    expect(written.runUpdates[0]).toMatchObject({ status: 'partial' });
  });

  it('without a project covering the month: no draft, the office is told', async () => {
    const { monthly, written } = setup({ projects: [{ ...PROJECT, date_end: '2026-09-30' }], contacts: CONTACTS, orders: [o(1, 1, '2026-10-05')] });
    const report = await monthly.run({ month: '2026-10' });
    expect(written.groups).toBeNull();
    expect(report.fatal[0]).toMatch(/Habilitar facturació automàtica/);
    expect(written.runUpdates[0]).toMatchObject({ status: 'failed' });
    expect(written.mails[0].html).toContain("No s'ha generat cap esborrany");
  });

  it('a preview writes nothing', async () => {
    const { monthly, written } = setup({ projects: [PROJECT], contacts: CONTACTS, orders: [o(1, 1, '2026-10-05')] });
    const report = await monthly.run({ month: '2026-10', preview: true });
    expect(report).toMatchObject({ preview: true, drafts: 1, reconciliation: { ok: true } });
    expect(written.groups).toBeNull();
    expect(written.runs).toEqual([]);
    expect(written.mails).toEqual([]);
    expect(written.notices).toEqual([]);
  });
});

describe('the cron (issues/430)', () => {
  const DUE = new Date('2026-10-29T13:30:00Z');

  it('leaves alone an entity where no project has the option', async () => {
    const { monthly, written } = setup({ projects: [], contacts: CONTACTS, orders: [o(1, 1, '2026-10-05')] });
    expect(await monthly.maybeRun(DUE)).toBeNull();
    expect(written.runs).toEqual([]);
  });

  it('runs the month once, on its day', async () => {
    let s = setup({ projects: [PROJECT], contacts: CONTACTS, orders: [o(1, 1, '2026-10-05')] });
    expect(await s.monthly.maybeRun(new Date('2026-10-28T13:30:00Z'))).toBeNull();
    expect(await s.monthly.maybeRun(DUE)).toMatchObject({ drafts: 1 });
    s = setup({ projects: [PROJECT], contacts: CONTACTS, orders: [o(1, 1, '2026-10-05')], runs: [{ month: '2026-10', trigger: 'cron' }] });
    expect(await s.monthly.maybeRun(DUE)).toBeNull();
    expect(s.written.runs).toEqual([]);
  });

  it('is scheduled every 10 minutes under a lock', () => {
    const cron = require('fs').readFileSync(require('path').join(__dirname, '../config/cron.js'), 'utf8');
    expect(cron).toContain("withCronLock('auto-invoicing', () => require('../src/services/monthly-invoicing/run').maybeRun())");
  });
});

describe('who reaches it (issues/430)', () => {
  it('the office runs it, members read their notices', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const a of ['status', 'preview', 'runNow', 'find']) {
      expect(isAllowed(`api::auto-invoicing-run.auto-invoicing-run.${a}`, ['orders_admin'])).toBe(true);
      expect(isAllowed(`api::auto-invoicing-run.auto-invoicing-run.${a}`, ['orders'])).toBe(false);
    }
    expect(isAllowed('api::member-notice.member-notice.find', ['orders'])).toBe(true);
    expect(isAllowed('api::member-notice.member-notice.update', ['orders'])).toBe(true);
    expect(isAllowed('api::member-notice.member-notice.create', ['orders'])).toBe(false);
  });
});
