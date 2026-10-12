'use strict';

/**
 * The life of an emitted invoice, as its lifecycles enforce it:
 *
 *   - it is born a draft (code ESBORRANY), with the first payment method, the
 *     client's details and its totals;
 *   - "Emetre factura" (state draft -> real) takes the next number of its serie
 *     and builds the code; the number is taken once;
 *   - an issued invoice keeps its number, code and lines whatever is saved later;
 *   - once issued it is queued for VeriFactu and FACe when those are switched on,
 *     once each.
 *
 * Until now only the end-to-end test covered issuing, and VeriFactu and FACe are
 * off there, so the queueing had no test at all.
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));

const INVOICE = 'api::emitted-invoice.emitted-invoice';
const SERIE = 'api::serie.serie';
const PAYMENT_METHOD = 'api::payment-method.payment-method';
const CONTACT = 'api::contact.contact';
const CHAIN = 'api::verifactu-chain.verifactu-chain';
const FACE_QUEUE = 'api::face-queue.face-queue';
const LINE = 'invoice-line.invoice-line';

let lifecycles;
let db;
let queries;
let pdf;

// What the database holds; each test changes what it needs.
const fresh = () => ({
  invoice: { id: 1, state: 'draft', code: 'ESBORRANY' },
  serie: { id: 3, name: '2026', emitted_invoice_number: 41, leadingZeros: 4 },
  paymentMethods: [
    { id: 1, name: 'Transferència', bank_account: { id: 10 } },
    { id: 2, name: 'Efectiu', bank_account: null },
  ],
  contact: {
    id: 9,
    name: 'Clienta SCCL',
    nif: 'F12345678',
    address: 'Carrer Major 1',
    city: 'Girona',
    face: false,
  },
  lines: [],
  chains: [],
  faceQueue: [],
  verifactu: { mode: 'off' },
  me: { face: 'off' },
});

beforeEach(() => {
  jest.resetModules();
  db = fresh();
  pdf = jest.fn(async () => {});

  queries = {
    [INVOICE]: { findOne: jest.fn(async () => db.invoice) },
    [SERIE]: {
      findOne: jest.fn(async ({ where }) => (db.serie && db.serie.id === where.id ? db.serie : null)),
      update: jest.fn(async ({ data }) => Object.assign(db.serie, data)),
    },
    [PAYMENT_METHOD]: {
      findOne: jest.fn(async ({ where } = {}) =>
        where ? db.paymentMethods.find((p) => p.id === where.id) || null : db.paymentMethods[0] || null,
      ),
    },
    [CONTACT]: { findOne: jest.fn(async ({ where }) => (db.contact.id === where.id ? db.contact : null)) },
    [LINE]: { findMany: jest.fn(async ({ where }) => db.lines.filter((l) => where.id.$in.includes(l.id))) },
    [CHAIN]: {
      findMany: jest.fn(async () => db.chains),
      create: jest.fn(async ({ data }) => db.chains.push(data)),
    },
    [FACE_QUEUE]: {
      findMany: jest.fn(async () => db.faceQueue),
      create: jest.fn(async ({ data }) => db.faceQueue.push(data)),
    },
  };
  global.strapi = {
    db: { query: jest.fn((uid) => queries[uid]) },
    documents: jest.fn((uid) => ({
      findFirst: jest.fn(async () => (uid === 'api::verifactu.verifactu' ? db.verifactu : db.me)),
    })),
    controller: jest.fn(() => ({ pdf })),
  };

  lifecycles = require('../src/api/emitted-invoice/content-types/emitted-invoice/lifecycles');
});

afterEach(() => {
  delete global.strapi;
});

const update = async (data) => {
  const event = { params: { where: { id: 1 }, data } };
  await lifecycles.beforeUpdate(event);
  return event.params.data;
};
const afterUpdate = (data = {}) =>
  lifecycles.afterUpdate({ params: { where: { id: 1 }, data }, result: { id: 1 } });

describe('a new invoice', () => {
  it('is a draft, whatever the client sends', async () => {
    const data = { state: 'real', code: '2026-0001', lines: [] };
    await lifecycles.beforeCreate({ params: { data } });

    expect(data).toMatchObject({ state: 'draft', code: 'ESBORRANY' });
    expect(queries[SERIE].update).not.toHaveBeenCalled();
  });

  it('takes the first payment method and its bank account when none is chosen', async () => {
    const data = { lines: [] };
    await lifecycles.beforeCreate({ params: { data } });

    expect(data).toMatchObject({ payment_method: 1, bank_account: 10 });
  });

  it('keeps the chosen payment method, with no bank account when it has none', async () => {
    const data = { payment_method: 2, lines: [] };
    await lifecycles.beforeCreate({ params: { data } });

    expect(data.payment_method).toBe(2);
    expect(data.bank_account).toBeUndefined();
  });

  it("copies the client's details onto the invoice", async () => {
    const data = { contact: 9, lines: [] };
    await lifecycles.beforeCreate({ params: { data } });

    expect(data.contact_info).toEqual({
      name: 'Clienta SCCL',
      nif: 'F12345678',
      address: 'Carrer Major 1',
      postcode: null,
      city: 'Girona',
      state: null,
      country: null,
    });
  });

  it('adds up its lines: discount first, then VAT and IRPF on the discounted base', async () => {
    const data = {
      lines: [
        { quantity: 2, base: 100, vat: 21, irpf: 15 },
        { quantity: 1, base: 50, discount: 10, vat: 10 },
        { quantity: 3, base: 0, vat: 21 },
      ],
    };
    await lifecycles.beforeCreate({ params: { data } });

    expect(data.total_base).toBe(245);
    expect(data.total_vat).toBeCloseTo(42 + 4.5, 9);
    expect(data.total_irpf).toBe(30);
    expect(data.total).toBeCloseTo(245 + 46.5 - 30, 9);
  });

  it('reads the line values back when v5 hands over bare references', async () => {
    db.lines = [{ id: 70, quantity: 2, base: 100, vat: 21 }];
    const data = { lines: [{ id: 70, __pivot: { field: 'lines' } }] };
    await lifecycles.beforeCreate({ params: { data } });

    expect([data.total_base, data.total_vat, data.total]).toEqual([200, 42, 242]);
  });

  it('renders its PDF', async () => {
    await lifecycles.afterCreate({ result: { id: 1 } });

    expect(pdf).toHaveBeenCalledWith({ params: { id: 1, doc: 'emitted-invoice' } });
  });
});

describe('issuing ("Emetre factura")', () => {
  const issue = (extra = {}) =>
    update({ state: 'real', code: 'ESBORRANY', serial: 3, user_last: 5, ...extra });

  it('takes the next number of the serie and builds the code from it', async () => {
    const data = await issue();

    expect(data).toMatchObject({ state: 'real', number: 42, code: '2026-0042', user_real: 5 });
    expect(queries[SERIE].update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { emitted_invoice_number: 42 },
    });
  });

  it('numbers consecutive invoices consecutively', async () => {
    const first = await issue();
    const second = await issue();

    expect([first.code, second.code]).toEqual(['2026-0042', '2026-0043']);
    expect(db.serie.emitted_invoice_number).toBe(43);
  });

  it("pads the number to the serie's leading zeros, not at all by default", async () => {
    db.serie = { id: 3, name: 'R', emitted_invoice_number: 6 };

    expect((await issue()).code).toBe('R-7');
  });

  it('uses the serie stored on the draft when the save does not send one', async () => {
    db.invoice.serial = { id: 3 };

    expect((await issue({ serial: undefined })).code).toBe('2026-0042');
  });

  it('keeps a number the invoice already has instead of taking a new one', async () => {
    // a conversion that failed halfway: the number was taken, the state was not saved
    db.invoice.number = 17;
    const data = await issue();

    expect(data).toMatchObject({ number: 17, code: '2026-0017' });
    expect(queries[SERIE].update).not.toHaveBeenCalled();
  });

  it('still converts when the client already holds the assigned code', async () => {
    db.invoice.number = 17;

    expect(await issue({ code: '2026-0017' })).toMatchObject({ state: 'real', code: '2026-0017' });
  });

  it('adds up the totals of the lines it is issued with', async () => {
    const data = await issue({ lines: [{ quantity: 2, base: 100, vat: 21, irpf: 15 }] });

    expect([data.total_base, data.total_vat, data.total_irpf, data.total]).toEqual([200, 42, 30, 212]);
  });

  it('a save as draft stays a draft and takes no number', async () => {
    for (const state of ['draft', undefined]) {
      const data = await update({ state, code: '2026-0099', serial: 3 });
      expect(data).toMatchObject({ state: 'draft', code: 'ESBORRANY' });
    }
    expect(queries[SERIE].update).not.toHaveBeenCalled();
  });
});

describe('an issued invoice', () => {
  beforeEach(() => {
    db.invoice = {
      id: 1,
      state: 'real',
      number: 42,
      code: '2026-0042',
      lines: [{ id: 70 }],
      contact: { id: 9 },
      emitted: '2026-03-02',
      serial: { id: 3 },
      comments: 'original',
      user_real: { id: 5 },
    };
  });

  it('keeps its code, lines, client, date, serie and comments whatever the save sends', async () => {
    const data = await update({
      state: 'real',
      code: 'ESBORRANY',
      lines: [{ quantity: 1, base: 1 }],
      contact: 77,
      emitted: '2020-01-01',
      serial: 8,
      comments: 'changed',
      paid: true,
    });

    expect(data).toMatchObject({
      code: '2026-0042',
      lines: [{ id: 70 }],
      contact: { id: 9 },
      emitted: '2026-03-02',
      serial: { id: 3 },
      comments: 'original',
      user_real: { id: 5 },
      // what may still change does
      paid: true,
    });
  });

  it('takes no new number', async () => {
    await update({ state: 'real', code: 'ESBORRANY' });

    expect(queries[SERIE].update).not.toHaveBeenCalled();
  });

  it('is not walked back to ESBORRANY by a save that leaves the state out', async () => {
    expect((await update({ paid: true })).code).toBe('2026-0042');
  });

  it('refuses every save once it is not updatable, unless an admin unlocks it', async () => {
    db.invoice.updatable = false;

    await expect(update({ paid: true })).rejects.toThrow('emitted-invoice NOT updatable');
    await expect(update({ paid: true, updatable_admin: true })).resolves.toMatchObject({ paid: true });
  });

  it('cannot be deleted', async () => {
    queries['api::order.order'] = { findMany: jest.fn(async () => []) };

    await expect(lifecycles.beforeDelete({ params: { where: { id: 1 } } })).rejects.toThrow(
      'Cannot delete a real invoice',
    );
  });
});

describe('VeriFactu queue', () => {
  beforeEach(() => {
    db.verifactu = { mode: 'real' };
    db.invoice = {
      id: 1,
      state: 'real',
      code: '2026-0042',
      verifactu: true,
      pdf: 'x.pdf',
      user_real: { id: 5 },
    };
  });

  it('queues an issued invoice for the tax agency, in the current mode', async () => {
    await afterUpdate();

    expect(db.chains).toHaveLength(1);
    expect(db.chains[0]).toMatchObject({
      emitted_invoice: 1,
      state: 'pending',
      mode: 'real',
      users_permissions_user: 5,
    });
    expect(JSON.parse(db.chains[0].invoice_json)).toMatchObject({ id: 1, code: '2026-0042' });
  });

  it('queues it once: later saves add nothing', async () => {
    await afterUpdate();
    await afterUpdate({ paid: true });

    expect(db.chains).toHaveLength(1);
  });

  it('leaves the user unset when nobody is recorded as the issuer (0 breaks the foreign key)', async () => {
    delete db.invoice.user_real;
    await afterUpdate();

    expect(db.chains).toHaveLength(1);
    expect('users_permissions_user' in db.chains[0]).toBe(false);
  });

  it('queues nothing for drafts, for invoices outside VeriFactu, or when it is switched off', async () => {
    db.invoice.state = 'draft';
    await afterUpdate();
    db.invoice.state = 'real';

    db.invoice.verifactu = false;
    await afterUpdate();
    db.invoice.verifactu = true;

    for (const verifactu of [null, { mode: 'off' }, {}]) {
      db.verifactu = verifactu;
      await afterUpdate();
    }

    expect(db.chains).toEqual([]);
  });
});

describe('FACe queue', () => {
  beforeEach(() => {
    db.me = { face: 'test' };
    db.contact.face = true;
    db.invoice = { id: 1, state: 'real', code: '2026-0042', pdf: 'x.pdf', contact: { id: 9 } };
  });

  it('queues an issued invoice whose client is a public administration', async () => {
    await afterUpdate();

    expect(db.faceQueue).toHaveLength(1);
    expect(db.faceQueue[0]).toMatchObject({ emitted_invoice: 1, mode: 'test', status: 'pending' });
  });

  it('queues it in real mode when FACe is in real mode', async () => {
    db.me.face = 'real';
    await afterUpdate();

    expect(db.faceQueue[0].mode).toBe('real');
  });

  it('queues it once', async () => {
    await afterUpdate();
    await afterUpdate();

    expect(db.faceQueue).toHaveLength(1);
  });

  it('queues nothing for other clients, drafts, invoices already sent, or when FACe is off', async () => {
    db.contact.face = false;
    await afterUpdate();
    db.contact.face = true;

    db.invoice.state = 'draft';
    await afterUpdate();
    db.invoice.state = 'real';

    db.invoice.face = true;
    await afterUpdate();
    db.invoice.face = false;

    delete db.invoice.contact;
    await afterUpdate();
    db.invoice.contact = { id: 9 };

    for (const me of [null, {}, { face: 'off' }]) {
      db.me = me;
      await afterUpdate();
    }

    expect(db.faceQueue).toEqual([]);
  });
});

describe('the invoice PDF after a save', () => {
  it('is rendered when the invoice has none yet', async () => {
    db.invoice = { id: 1, state: 'draft', code: 'ESBORRANY' };
    await afterUpdate();

    expect(pdf).toHaveBeenCalledWith({ params: { id: 1, doc: 'emitted-invoice' } });
  });

  it('is left alone when there is one', async () => {
    db.invoice = { id: 1, state: 'draft', code: 'ESBORRANY', pdf: 'x.pdf' };
    await afterUpdate({ paid: true });

    expect(pdf).not.toHaveBeenCalled();
  });

  it('does not fail the save when it cannot be rendered', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    pdf.mockRejectedValue(new Error('no logo file'));
    db.invoice = { id: 1, state: 'draft', code: 'ESBORRANY' };

    await expect(afterUpdate()).resolves.toBeUndefined();
    error.mockRestore();
  });
});
