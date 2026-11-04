'use strict';

/**
 * 2026-11-04 — IVA › Models 303 i 390 (Beta), phase 3: the services that load
 * the year, mark a return as filed (a snapshot built on the server), set the
 * final prorrata and build the AEAT file, the classification writes, and the
 * controller's answers. The validation of branch model-303 found them with no
 * test (services/vat-returns.js at 0 %, classifyDocuments untested).
 */

const RETURN = 'api::vat-return.vat-return';
const EMITTED = 'api::emitted-invoice.emitted-invoice';
const RECEIVED = 'api::received-invoice.received-invoice';
const YEAR = 'api::year.year';

const line = (base, vat) => ({ quantity: 1, base, discount: 0, vat });
const contact = { id: 1, name: 'Client', nif: 'B12345678', country: null };
const doc = (id, emitted, lines, extra = {}) => ({ id, code: `D${id}`, emitted, lines, contact, ...extra });

// T1: 210 charged − 420 deducted = −210; T2: 105 charged
const DOCS = {
  [EMITTED]: [doc(1, '2026-01-15', [line(1000, 21)], { state: 'real' }), doc(2, '2026-04-15', [line(500, 21)], { state: 'real' })],
  [RECEIVED]: [doc(10, '2026-02-10', [line(2000, 21)])],
};

function stubStrapi({ returns = [], years = [{ id: 1, year: 2026, deductible_vat_pct: 100 }], me = { nif: 'B12345678', name: 'Coop Prova' } } = {}) {
  const calls = { create: [], update: [], delete: [], queries: [] };
  const query = (uid) => ({
    findMany: async (params = {}) => {
      calls.queries.push({ uid, params });
      if (uid === RETURN) return returns;
      if (uid === YEAR) return years;
      // other years' classified documents (the proposals)
      if (params.where && params.where.$not) return [];
      return DOCS[uid] || [];
    },
    findOne: async ({ where }) => {
      if (uid === RETURN) {
        return returns.find((r) => (where.id !== undefined ? r.id === where.id : r.model === where.model && r.year === where.year && r.period === where.period)) || null;
      }
      if (uid === YEAR) return years.find((y) => y.year === where.year) || null;
      if (uid === 'api::verifactu.verifactu') return { software_version: '1', software_developerIrsId: 'B99999999' };
      return null;
    },
    create: async ({ data }) => {
      calls.create.push({ uid, data });
      return { id: 99, ...data };
    },
    update: async ({ where, data }) => {
      calls.update.push({ uid, where, data });
      return { ...where, ...data };
    },
    delete: async ({ where }) => {
      calls.delete.push({ uid, where });
      return where;
    },
  });
  global.strapi = { db: { query }, documents: () => ({ findFirst: async () => me }) };
  return calls;
}

describe('marking a return as filed', () => {
  let svc;
  beforeEach(() => {
    jest.resetModules();
    svc = require('../src/api/treasury/services/vat-returns');
  });

  it('loads the year and the year before’s 4T', async () => {
    const calls = stubStrapi();
    await svc.computeVatModels(2026);
    const returnsQuery = calls.queries.find((q) => q.uid === RETURN);
    expect(returnsQuery.params.where).toEqual({ $or: [{ year: 2026 }, { year: 2025, model: '303', period: '4T' }] });
    const emitted = calls.queries.find((q) => q.uid === EMITTED && !q.params.where.$not);
    expect(emitted.params.where).toEqual({ emitted: { $gte: '2026-01-01', $lte: '2026-12-31' } });
  });

  it('keeps the quarter’s boxes, documents and result, built on the server', async () => {
    const calls = stubStrapi();
    await svc.fileReturn({ model: '303', year: '2026', period: '1T', declaration_type: 'C', filed_date: '2026-04-18', receipt: 'R1', boxes: { '71': 1 } }, { id: 5 });
    expect(calls.update).toEqual([]);
    expect(calls.create).toHaveLength(1);
    const { data } = calls.create[0];
    expect(data).toMatchObject({ model: '303', year: 2026, period: '1T', declaration_type: 'C', filed_date: '2026-04-18', receipt: 'R1', filed_by: 5, result: -210 });
    // what the client sent as boxes is ignored
    expect(data.boxes['71']).toBe(-210);
    expect(data.boxes['09']).toBe(210);
    expect(data.boxes['29']).toBe(420);
    expect(Object.keys(data.documents).sort()).toEqual(['emitted-invoices:1:21', 'received-invoices:10:21:c']);
  });

  it('replaces the snapshot of a return filed again', async () => {
    const calls = stubStrapi({ returns: [{ id: 3, model: '303', year: 2026, period: '1T', declaration_type: 'C', boxes: { '71': -999, '87': 0 } }] });
    await svc.fileReturn({ model: '303', year: 2026, period: '1T', declaration_type: 'C', filed_date: '2026-04-20' }, { id: 5 });
    expect(calls.create).toEqual([]);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].where).toEqual({ id: 3 });
    expect(calls.update[0].data.boxes['71']).toBe(-210);
  });

  it('carries the filed quarter into the next one', async () => {
    const calls = stubStrapi({ returns: [{ id: 3, model: '303', year: 2026, period: '1T', declaration_type: 'C', boxes: { '71': -300, '87': 0 } }] });
    await svc.fileReturn({ model: '303', year: 2026, period: '2T', declaration_type: 'N', filed_date: '2026-07-20' }, null);
    const { data } = calls.create[0];
    // T2: 105 charged, 300 pending from the filed T1 → 105 applied, 195 left
    expect(data.boxes['110']).toBe(300);
    expect(data.boxes['78']).toBe(105);
    expect(data.boxes['87']).toBe(195);
    expect(data.result).toBe(0);
    expect(data.filed_by).toBe(null);
  });

  it('files the 390 with its own boxes', async () => {
    const calls = stubStrapi();
    await svc.fileReturn({ model: '390', year: 2026, period: '0A', filed_date: '2027-01-30' }, { id: 5 });
    const { data } = calls.create[0];
    expect(data).toMatchObject({ model: '390', period: '0A', declaration_type: null });
    expect(data.boxes['06']).toBe(315);
    expect(data.result).toBe(data.boxes['86']);
  });

  it.each([
    [{ model: '111', year: 2026, period: '1T', declaration_type: 'I' }, /Model no vàlid/],
    [{ model: '303', year: 2026, period: '5T', declaration_type: 'I' }, /Període no vàlid/],
    [{ model: '303', year: 1990, period: '1T', declaration_type: 'I' }, /Any no vàlid/],
    [{ model: '303', year: 2026, period: '1T', declaration_type: 'Z' }, /Tipus de declaració no vàlid/],
    [{ model: '303', year: 2026, period: '1T' }, /Tipus de declaració no vàlid/],
    [{ model: '303', year: 2026, period: '2T', declaration_type: 'D' }, /Només es pot demanar la devolució al 4T/],
    [{ model: '303', year: 2026, period: '1T', declaration_type: 'C', filed_date: '18/04/2026' }, /Data no vàlida/],
  ])('refuses %j and writes nothing', async (body, message) => {
    const calls = stubStrapi();
    await expect(svc.fileReturn(body, { id: 5 })).rejects.toThrow(message);
    await expect(svc.fileReturn(body, { id: 5 })).rejects.toBeInstanceOf(svc.VatReturnError);
    expect(calls.create).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it('allows the refund in the 4T', async () => {
    DOCS[RECEIVED].push(doc(11, '2026-11-10', [line(100, 21)]));
    try {
      const calls = stubStrapi();
      await svc.fileReturn({ model: '303', year: 2026, period: '4T', declaration_type: 'D', filed_date: '2027-01-30' }, { id: 5 });
      expect(calls.create[0].data).toMatchObject({ declaration_type: 'D', result: -21 });
    } finally {
      DOCS[RECEIVED].pop();
    }
  });

  const T1_NOTHING = { id: 3, model: '303', year: 2026, period: '1T', declaration_type: 'N', boxes: { '71': 0, '87': 0 } };

  // validation of model-303 (2026-11-04): the API took any type, e.g. «a
  // compensar» for a quarter to pay
  it.each([
    ['1T', 'I'], ['1T', 'U'], ['1T', 'N'], // −210
    ['2T', 'C'], ['2T', 'N'], // +105 (the filed T1 left nothing to compensate)
    ['3T', 'I'], ['3T', 'C'], // 0
  ])('refuses the %s filed as %s, which its result does not allow', async (period, type) => {
    const calls = stubStrapi({ returns: [T1_NOTHING] });
    await expect(svc.fileReturn({ model: '303', year: 2026, period, declaration_type: type, filed_date: '2026-10-20' }, { id: 5 }))
      .rejects.toThrow(/el tipus de declaració ha de ser/);
    expect(calls.create).toEqual([]);
  });

  it('takes the types its result allows', async () => {
    for (const [period, type] of [['1T', 'C'], ['2T', 'I'], ['2T', 'U'], ['3T', 'N']]) {
      const calls = stubStrapi({ returns: [T1_NOTHING] });
      await svc.fileReturn({ model: '303', year: 2026, period, declaration_type: type, filed_date: '2026-10-20' }, { id: 5 });
      // the 1T is filed again over T1_NOTHING
      expect([...calls.create, ...calls.update][0].data.declaration_type).toBe(type);
    }
  });

  it('unmarks a filed return', async () => {
    const calls = stubStrapi({ returns: [{ id: 3, model: '303', year: 2026, period: '1T' }] });
    await expect(svc.unfileReturn('3')).resolves.toEqual({ id: 3 });
    expect(calls.delete).toEqual([{ uid: RETURN, where: { id: 3 } }]);
    await expect(svc.unfileReturn(4)).rejects.toThrow('Declaració no trobada.');
    expect(calls.delete).toHaveLength(1);
  });
});

describe('the final prorrata', () => {
  let svc;
  beforeEach(() => {
    jest.resetModules();
    svc = require('../src/api/treasury/services/vat-returns');
  });

  it('sets and clears the year’s final percentage', async () => {
    const calls = stubStrapi();
    await expect(svc.setFinalProrrata('2026', '75')).resolves.toEqual({ year: 2026, final_deductible_vat_pct: 75 });
    await expect(svc.setFinalProrrata(2026, '')).resolves.toEqual({ year: 2026, final_deductible_vat_pct: null });
    expect(calls.update.map((u) => [u.uid, u.where, u.data])).toEqual([
      [YEAR, { id: 1 }, { final_deductible_vat_pct: 75 }],
      [YEAR, { id: 1 }, { final_deductible_vat_pct: null }],
    ]);
  });

  it.each([[120], [-1], ['abc']])('refuses %p', async (pct) => {
    const calls = stubStrapi();
    await expect(svc.setFinalProrrata(2026, pct)).rejects.toThrow(/Percentatge no vàlid/);
    expect(calls.update).toEqual([]);
  });

  it('refuses a year that is not in Configuració › Anys', async () => {
    const calls = stubStrapi();
    await expect(svc.setFinalProrrata(2031, 80)).rejects.toThrow(/L'any 2031 no és a Configuració › Anys/);
    expect(calls.update).toEqual([]);
  });
});

describe('the AEAT file', () => {
  let svc;
  beforeEach(() => {
    jest.resetModules();
    svc = require('../src/api/treasury/services/vat-returns');
  });

  it('writes a quarter with the declaration type its result gives', async () => {
    stubStrapi();
    const { name, content } = await svc.buildFile({ model: '303', year: '2026', period: '1T' });
    expect(name).toBe('303_2026_1T.txt');
    expect(content.startsWith('<T303020261T0000>')).toBe(true);
    expect(content.endsWith('</T303020261T0000>')).toBe(true);
    // page 01, field 6 = declaration type: −210 → C
    const page1 = content.slice(content.indexOf('<T30301000>'));
    expect(page1.slice(12, 13)).toBe('C');
    expect(content).toContain('B12345678COOP PROVA');
    // no prorrata page without a prorrata, nor outside the 4T
    expect(content).not.toContain('<T30305000>');
  });

  it('adds the prorrata page to the 4T when the year has one', async () => {
    DOCS[EMITTED].push(doc(3, '2026-11-10', [line(1000, 0)], { state: 'real', vat_operation: 'E1' }));
    try {
      stubStrapi({ years: [{ id: 1, year: 2026, deductible_vat_pct: 80, final_deductible_vat_pct: 70 }] });
      const { content } = await svc.buildFile({ model: '303', year: 2026, period: '4T', declaration_type: 'C' });
      expect(content).toContain('<T30305000>');
    } finally {
      DOCS[EMITTED].pop();
    }
  });

  it('writes the year’s 390', async () => {
    stubStrapi();
    const { name, content } = await svc.buildFile({ model: '390', year: 2026, period: '4T' });
    expect(name).toBe('390_2026.txt');
    expect(content.startsWith('<T390020260A0000>')).toBe(true);
  });

  it('asks for the NIF and the IBAN', async () => {
    stubStrapi({ me: { name: 'Sense NIF' } });
    await expect(svc.buildFile({ model: '303', year: 2026, period: '1T' })).rejects.toBeInstanceOf(svc.AeatFileError);
    stubStrapi();
    await expect(svc.buildFile({ model: '303', year: 2026, period: '2T', declaration_type: 'U' })).rejects.toThrow(/IBAN/);
    await expect(svc.buildFile({ model: '303', year: 2026, period: '9T' })).rejects.toBeInstanceOf(svc.VatReturnError);
  });
});

describe('classifying documents', () => {
  let logChanges;
  let writes;
  beforeEach(() => {
    jest.resetModules();
    logChanges = jest.fn(async () => {});
    jest.doMock('../src/services/change-log', () => ({ logChanges }));
    writes = [];
    const rows = {
      [RECEIVED]: [{ id: 3, code: 'R3', reverse_charge: null, reverse_charge_rate: 21, vat_special: null }],
      [EMITTED]: [{ id: 1, code: 'F1', vat_operation: 'N1' }],
    };
    global.strapi = {
      db: {
        metadata: { get: (uid) => ({ tableName: uid === EMITTED ? 'emitted_invoices' : 'received_invoices' }) },
        query: (uid) => ({ findMany: async ({ where }) => rows[uid].filter((r) => where.id.$in.includes(r.id)) }),
        connection: (table) => ({ where: (w) => ({ update: async (data) => writes.push({ table, where: w, data }) }) }),
      },
    };
  });

  it('writes the columns raw and logs each change', async () => {
    const { classifyDocuments } = require('../src/api/treasury/services/vat-classify');
    const answer = await classifyDocuments([
      { kind: 'received-invoices', id: 3, value: 'intracom_goods', rate: 10 },
      { kind: 'received-invoices', id: 404, value: 'isp' }, // gone: not counted
      { kind: 'emitted-invoices', id: 1, value: 'E1' },
    ]);
    expect(answer).toEqual({ updated: 2 });
    expect(writes).toEqual([
      { table: 'received_invoices', where: { id: 3 }, data: { reverse_charge: 'intracom_goods', reverse_charge_rate: 10 } },
      { table: 'emitted_invoices', where: { id: 1 }, data: { vat_operation: 'E1' } },
    ]);
    expect(logChanges).toHaveBeenCalledWith(RECEIVED, [
      { row: { id: 3, code: 'R3' }, changes: [{ field: 'reverse_charge', from: null, to: 'intracom_goods' }, { field: 'reverse_charge_rate', from: 21, to: 10 }] },
    ]);
    expect(logChanges).toHaveBeenCalledWith(EMITTED, [{ row: { id: 1, code: 'F1' }, changes: [{ field: 'vat_operation', from: 'N1', to: 'E1' }] }]);
  });
});

describe('the controller', () => {
  let controller;
  beforeEach(() => {
    jest.resetModules();
    stubStrapi();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    controller = require('../src/api/treasury/controllers/treasury');
  });
  const ctx = (extra = {}) => ({
    query: {},
    params: {},
    request: { body: {} },
    state: { user: { id: 5 } },
    set: jest.fn(),
    badRequest: jest.fn((m) => ({ status: 400, m })),
    notFound: jest.fn((m) => ({ status: 404, m })),
    ...extra,
  });

  it('answers the errors of the services as 400 / 404', async () => {
    const c1 = ctx({ request: { body: { model: '303', year: 2026, period: '2T', declaration_type: 'D' } } });
    await controller.vatModelsFile(c1);
    expect(c1.badRequest).toHaveBeenCalledWith('Només es pot demanar la devolució al 4T.');
    const c2 = ctx({ params: { id: '77' } });
    await controller.vatModelsUnfile(c2);
    expect(c2.notFound).toHaveBeenCalledWith('Declaració no trobada.');
    const c3 = ctx({ request: { body: { year: 2026, pct: 150 } } });
    await controller.vatModelsFinalProrrata(c3);
    expect(c3.badRequest).toHaveBeenCalled();
    const c4 = ctx({ request: { body: { items: [] } } });
    await controller.vatModelsClassify(c4);
    expect(c4.badRequest).toHaveBeenCalledWith('Cap document per classificar.');
  });

  it('sends the AEAT file in Latin-1 as an attachment', async () => {
    const c = ctx({ query: { model: '303', year: '2026', period: '1T' } });
    await controller.vatModelsAeatFile(c);
    expect(c.set).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=ISO-8859-1');
    expect(c.set).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="303_2026_1T.txt"');
    expect(Buffer.isBuffer(c.body)).toBe(true);
  });

  it('gives the year’s boxes', async () => {
    const c = ctx({ query: { year: '2026' } });
    await controller.vatModels(c);
    expect(c.body.year).toBe(2026);
    expect(c.body.quarters[0].boxes['71']).toBe(-210);
  });
});

// 2026-11-04: the AEAT's PDF of a filed return (the receipt with its CSV) is
// kept with the return, so the quarter opens what was really filed.
describe('the receipt PDF of a filed return', () => {
  const FILE = 'plugin::upload.file';
  let svc;
  // files by id, the ids already linked to some record, and the files removed
  function stubFiles({ returns, files = [], linked = [] }) {
    const calls = stubStrapi({ returns });
    const base = global.strapi.db.query;
    calls.removed = [];
    global.strapi.db.query = (uid) => (uid === FILE
      ? { findOne: async ({ where }) => files.find((f) => f.id === where.id) || null }
      : base(uid));
    global.strapi.db.connection = () => ({ where: ({ file_id: id }) => ({ first: async () => (linked.includes(id) ? { file_id: id } : undefined) }) });
    global.strapi.plugin = () => ({ service: () => ({ remove: async (f) => { calls.removed.push(f.id); } }) });
    return calls;
  }
  const pdf = (id) => ({ id, name: `303_${id}.pdf`, url: `/uploads/303_${id}_abc.pdf`, ext: '.pdf', mime: 'application/pdf' });
  beforeEach(() => {
    jest.resetModules();
    svc = require('../src/api/treasury/services/vat-returns');
  });

  it('links a just uploaded PDF and deletes the one it replaces', async () => {
    const calls = stubFiles({ returns: [{ id: 3, model: '303', year: 2025, period: '1T', receipt_file: { id: 7 } }], files: [pdf(7), pdf(8)], linked: [7] });
    await expect(svc.attachReceipt('3', 8)).resolves.toEqual({ id: 3, receipt_file: { id: 8, name: '303_8.pdf', url: '/uploads/303_8_abc.pdf' } });
    expect(calls.update).toEqual([{ uid: RETURN, where: { id: 3 }, data: { receipt_file: 8 } }]);
    expect(calls.removed).toEqual([7]);
  });

  it('keeps the same PDF when it is sent again, and takes it away with null', async () => {
    const calls = stubFiles({ returns: [{ id: 3, model: '303', year: 2025, period: '1T', receipt_file: { id: 7 } }], files: [pdf(7)], linked: [7] });
    await svc.attachReceipt(3, 7);
    expect(calls.removed).toEqual([]);
    await expect(svc.attachReceipt(3, null)).resolves.toEqual({ id: 3, receipt_file: null });
    expect(calls.update[1].data).toEqual({ receipt_file: null });
    expect(calls.removed).toEqual([7]);
  });

  it('refuses another record’s file, a file that is not a PDF, and a return that does not exist', async () => {
    stubFiles({
      returns: [{ id: 3, model: '303', year: 2025, period: '1T' }],
      files: [pdf(9), { id: 10, name: 'a.png', url: '/uploads/a.png', ext: '.png', mime: 'image/png' }],
      linked: [9],
    });
    await expect(svc.attachReceipt(3, 9)).rejects.toThrow("Aquest fitxer ja és d'un altre document.");
    await expect(svc.attachReceipt(3, 10)).rejects.toThrow('El justificant ha de ser un PDF.');
    await expect(svc.attachReceipt(3, 11)).rejects.toThrow('Fitxer no trobat.');
    await expect(svc.attachReceipt(3, 'x')).rejects.toThrow('Fitxer no vàlid.');
    await expect(svc.attachReceipt(4, 9)).rejects.toBeInstanceOf(svc.VatReturnNotFound);
    // an id that is no number is no return (it was a query on NaN: 500)
    await expect(svc.attachReceipt('undefined', 9)).rejects.toBeInstanceOf(svc.VatReturnNotFound);
    await expect(svc.unfileReturn('undefined')).rejects.toThrow('Declaració no trobada.');
  });

  it('deletes the receipt with the return when it is unmarked', async () => {
    const calls = stubFiles({ returns: [{ id: 3, model: '303', year: 2025, period: '1T', receipt_file: { id: 7 } }], files: [pdf(7)] });
    await svc.unfileReturn(3);
    expect(calls.removed).toEqual([7]);
  });

  it('loads the returns with their receipt and gives its name and address', async () => {
    const calls = stubFiles({ returns: [{ id: 3, model: '303', year: 2026, period: '1T', declaration_type: 'I', boxes: {}, receipt_file: pdf(7) }] });
    const r = await svc.computeVatModels(2026);
    expect(calls.queries.find((q) => q.uid === RETURN).params.populate).toEqual({ receipt_file: { select: ['id', 'name', 'url', 'ext', 'mime', 'size'] } });
    expect(r.quarters[0].filed.receipt_file).toEqual({ id: 7, name: '303_7.pdf', url: '/uploads/303_7_abc.pdf' });
  });

  it('answers 404 for a return that does not exist and 400 for a bad file', async () => {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    stubFiles({ returns: [{ id: 3, model: '303', year: 2025, period: '1T' }], files: [] });
    const controller = require('../src/api/treasury/controllers/treasury');
    const c = (params, body) => ({ params, request: { body }, badRequest: jest.fn(), notFound: jest.fn() });
    const missing = c({ id: '4' }, { file: 1 });
    await controller.vatModelsReceipt(missing);
    expect(missing.notFound).toHaveBeenCalledWith('Declaració no trobada.');
    const bad = c({ id: '3' }, { file: 1 });
    await controller.vatModelsReceipt(bad);
    expect(bad.badRequest).toHaveBeenCalledWith('Fitxer no trobat.');
  });
});
