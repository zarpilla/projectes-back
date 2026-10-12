'use strict';

/**
 * Sending issued invoices to the tax agency (VeriFactu).
 *
 * A queued invoice (a `verifactu-chain` row, see tests/emitted-invoice-issue.test.js)
 * is turned into a registration record, chained to the hash of the last accepted
 * one, posted to AEAT with the entity's certificate, and its answer decides the
 * state of the row and whether the invoice gets its QR.
 *
 * None of this had a test: VeriFactu is switched off in the end-to-end database,
 * because it can't be tried without talking to AEAT. Here the record is built
 * for real (verifactu-node-lib) and only the HTTP call is faked.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios', () => jest.fn());

const CHAIN = 'api::verifactu-chain.verifactu-chain';
const INVOICE = 'api::emitted-invoice.emitted-invoice';

const answer = (envio, registro) =>
  `<env:Envelope><env:Body><tikR:RespuestaRegFactuSistemaFacturacion><tikR:EstadoEnvio>${envio}</tikR:EstadoEnvio>` +
  `<tikR:RespuestaLinea><tikR:EstadoRegistro>${registro}</tikR:EstadoRegistro></tikR:RespuestaLinea>` +
  '</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>';
const ACCEPTED = answer('Correcto', 'Correcto');
const ACCEPTED_WITH_REMARKS = answer('ParcialmenteCorrecto', 'AceptadoConErrores');
const REJECTED = answer('Incorrecto', 'Incorrecto');

let publicDir;
let axios;
let lifecycles;
let db;
let chainUpdates;
let invoiceUpdates;
let warnings;

const invoice = (id, code, extra = {}) => ({
  id,
  code,
  createdAt: '2026-03-02T10:00:00.000Z',
  contact: { id: 9 },
  serial: { id: 3 },
  lines: [{ quantity: 2, base: 100, vat: 21 }],
  total_base: 200,
  total_vat: 42,
  ...extra,
});
const chain = (id, state, emitted_invoice, extra = {}) => ({
  id,
  state,
  mode: 'test',
  emitted_invoice,
  ...extra,
});

beforeAll(() => {
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifactu-test-'));
  fs.mkdirSync(path.join(publicDir, 'uploads'));
  // only read and handed to the HTTPS agent, which the fake request never uses
  fs.writeFileSync(path.join(publicDir, 'uploads', 'cert.p12'), 'not a real certificate');
});

afterAll(() => {
  fs.rmSync(publicDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.resetModules();
  axios = require('axios');
  axios.mockReset();
  axios.mockResolvedValue({ status: 200, data: ACCEPTED });

  chainUpdates = [];
  invoiceUpdates = [];
  warnings = [];
  db = {
    me: { nif: 'B12345674', name: 'Cooperativa SCCL' },
    verifactu: {
      mode: 'test',
      certificate: { url: '/uploads/cert.p12' },
      certificate_password: 'secret',
      software_developerName: 'Dev SCCL',
      software_developerIrsId: 'B12345674',
      software_name: 'ESSTRAPIS',
      software_id: '01',
      software_version: '5',
      software_number: '1',
      software_useOnlyVerifactu: true,
      software_useMulti: false,
      software_useCurrentMulti: false,
    },
    contacts: { 9: { id: 9, name: 'Clienta SL', nif: 'A58818501' } },
    series: { 3: { id: 3, name: '2026' } },
    chains: [chain(11, 'pending', invoice(1, '2026-0042'))],
  };

  const queries = {
    'api::me.me': { findOne: async () => db.me },
    'api::contact.contact': { findOne: async ({ where }) => db.contacts[where.id] || null },
    'api::serie.serie': { findOne: async ({ where }) => db.series[where.id] || null },
    [CHAIN]: {
      // the pending ones in id order, or the accepted ones newest first
      findMany: async ({ where }) => {
        const states = where.state.$in || [where.state];
        const rows = db.chains.filter((c) => states.includes(c.state) && c.mode === where.mode);
        return rows.sort((a, b) => (where.state.$in ? a.id - b.id : b.id - a.id));
      },
      update: async ({ where, data }) => {
        chainUpdates.push({ id: where.id, ...data });
        Object.assign(
          db.chains.find((c) => c.id === where.id),
          data,
        );
      },
    },
    [INVOICE]: {
      update: async ({ where, data }) => invoiceUpdates.push({ id: where.id, ...data }),
    },
  };
  global.strapi = {
    db: { query: (uid) => queries[uid] },
    documents: () => ({ findFirst: async () => db.verifactu }),
    dirs: { static: { public: publicDir } },
    log: { warn: (message) => warnings.push(message) },
  };

  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  lifecycles = require('../src/api/verifactu-chain/content-types/verifactu-chain/lifecycles');
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.strapi;
});

// a new row in the queue starts the run
const send = () => lifecycles.afterCreate({});
const sentXml = (call = 0) => axios.mock.calls[call][0].data;
const tag = (xml, name) => (xml.match(new RegExp(`<[^>]*:${name}>([^<]*)<`)) || [])[1];
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<[^>]*:${name}>([^<]*)<`, 'g'))].map((m) => m[1]);

describe('the record sent to AEAT', () => {
  it('carries the issuer, the client, the invoice code and its amounts', async () => {
    await send();
    const xml = sentXml();

    expect(axios).toHaveBeenCalledTimes(1);
    expect(tag(xml, 'IDEmisorFactura')).toBe('B12345674');
    expect(tag(xml, 'NumSerieFactura')).toBe('2026-0042');
    expect(tag(xml, 'FechaExpedicionFactura')).toBe('02-03-2026');
    expect(tag(xml, 'TipoFactura')).toBe('F1');
    expect(xml).toContain('<sum1:NombreRazon>Clienta SL</sum1:NombreRazon><sum1:NIF>A58818501</sum1:NIF>');
    expect(tag(xml, 'BaseImponibleOimporteNoSujeto')).toBe('200.00');
    expect(tag(xml, 'CuotaRepercutida')).toBe('42.00');
    expect(tag(xml, 'CuotaTotal')).toBe('42.00');
    expect(tag(xml, 'ImporteTotal')).toBe('242.00');
    expect(tag(xml, 'NombreSistemaInformatico')).toBe('ESSTRAPIS');
  });

  it('goes to the test endpoint in test mode and to the real one in real mode, with the certificate', async () => {
    await send();
    const test = axios.mock.calls[0][0];
    expect(test).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
    expect(test.url).toMatch(/^https:\/\/prewww/);
    expect(test.httpsAgent.options.pfx.toString()).toBe('not a real certificate');
    expect(test.httpsAgent.options.passphrase).toBe('secret');

    db.verifactu.mode = 'real';
    db.chains = [chain(12, 'pending', invoice(2, '2026-0043'), { mode: 'real' })];
    await send();
    const real = axios.mock.calls[1][0];
    expect(real.url).toMatch(/^https:\/\//);
    expect(real.url).not.toMatch(/prewww/);
  });

  it('groups the lines by VAT rate, after their discounts', async () => {
    db.chains[0].emitted_invoice = invoice(1, '2026-0042', {
      lines: [
        { quantity: 2, base: 100, vat: 21 },
        { quantity: 1, base: 100, vat: 21, discount: 50 },
        { quantity: 1, base: 33.33, vat: 10 },
        { quantity: 1, base: 80, vat: 0 },
      ],
      total_base: 363.33,
      total_vat: 55.83,
    });
    await send();
    const xml = sentXml();

    expect(tags(xml, 'TipoImpositivo')).toEqual(['21.00', '10.00']);
    expect(tags(xml, 'BaseImponibleOimporteNoSujeto')).toEqual(['250.00', '33.33', '80.00']);
    expect(tags(xml, 'CuotaRepercutida')).toEqual(['52.50', '3.33']);
    // the line without VAT is exempt, not taxed at 0 %
    expect(tags(xml, 'CalificacionOperacion')).toEqual(['S1', 'S1', 'N1']);
    expect(tag(xml, 'ImporteTotal')).toBe('419.16');
  });

  it('adjusts the largest VAT amount when rounding by rate drifts from the invoice total', async () => {
    db.chains[0].emitted_invoice = invoice(1, '2026-0042', {
      lines: [
        { quantity: 1, base: 100, vat: 21 },
        { quantity: 1, base: 10, vat: 10 },
      ],
      total_base: 110,
      total_vat: 22.05, // the invoice says 5 cents more than the lines add up to
    });
    await send();

    expect(tags(sentXml(), 'CuotaRepercutida')).toEqual(['21.05', '1.00']);
  });

  it('is a rectifying invoice (R1) when its serie is rectificative', async () => {
    db.series[3].rectificative = true;
    await send();

    expect(tag(sentXml(), 'TipoFactura')).toBe('R1');
  });

  it('identifies a foreign client by country and document instead of a Spanish NIF', async () => {
    db.contacts[9] = { id: 9, name: 'Client SARL', nif: 'FR12345678901', country: 'FR' };
    db.chains[0].emitted_invoice = invoice(1, '2026-0042', {
      lines: [{ quantity: 1, base: 200, vat: 0 }],
      total_vat: 0,
    });
    await send();
    const xml = sentXml();

    expect(tag(xml, 'CodigoPais')).toBe('FR');
    expect(tag(xml, 'IDType')).toBe('04');
    expect(tag(xml, 'ID')).toBe('FR12345678901');
    // not subject by location rules, instead of exempt
    expect(tag(xml, 'CalificacionOperacion')).toBe('N2');
  });
});

describe('the chain', () => {
  it('links each record to the hash of the last accepted one before it', async () => {
    db.chains = [
      chain(8, 'ok', invoice(5, '2026-0040', { createdAt: '2026-02-27T09:00:00.000Z' }), { hash: 'OLDER' }),
      chain(9, 'ok', invoice(6, '2026-0041', { createdAt: '2026-03-01T09:00:00.000Z' }), {
        hash: 'PREVIOUSHASH',
      }),
      chain(11, 'pending', invoice(1, '2026-0042')),
    ];
    await send();
    const previous = sentXml().match(/<sum1:RegistroAnterior>(.*)<\/sum1:RegistroAnterior>/)[1];

    expect(tag(previous, 'NumSerieFactura')).toBe('2026-0041');
    expect(tag(previous, 'FechaExpedicionFactura')).toBe('01-03-2026');
    expect(tag(previous, 'Huella')).toBe('PREVIOUSHASH');
  });

  it('marks the first record of all as the first', async () => {
    await send();

    expect(sentXml()).not.toContain('RegistroAnterior');
    expect(tag(sentXml(), 'PrimerRegistro')).toBe('S');
  });

  it('sends the pending ones in order, each chained to the one just accepted', async () => {
    db.chains = [
      chain(12, 'pending', invoice(2, '2026-0043')),
      chain(11, 'pending', invoice(1, '2026-0042')),
    ];
    await send();

    expect(axios).toHaveBeenCalledTimes(2);
    expect(tag(sentXml(0), 'NumSerieFactura')).toBe('2026-0042');
    const previous = sentXml(1).match(/<sum1:RegistroAnterior>(.*)<\/sum1:RegistroAnterior>/)[1];
    expect(tag(previous, 'NumSerieFactura')).toBe('2026-0042');
    expect(tag(previous, 'Huella')).toBe(db.chains.find((c) => c.id === 11).hash);
  });

  it('only chains records of the same mode', async () => {
    db.chains = [
      chain(9, 'ok', invoice(6, '2026-0041'), { hash: 'REALHASH', mode: 'real' }),
      chain(11, 'pending', invoice(1, '2026-0042')),
      chain(12, 'pending', invoice(2, '2026-0043'), { mode: 'real' }),
    ];
    await send();

    expect(axios).toHaveBeenCalledTimes(1);
    expect(sentXml()).not.toContain('REALHASH');
  });
});

describe('the answer', () => {
  it('accepted: the row is ok and the invoice gets its QR', async () => {
    await send();

    expect(db.chains[0]).toMatchObject({ state: 'ok', actions: 'none', response_text: ACCEPTED });
    expect(db.chains[0].hash).toMatch(/^[0-9A-F]{64}$/);
    // the request body is the stored XML, trimmed
    expect(db.chains[0].xml.trim()).toBe(sentXml());
    expect(invoiceUpdates).toEqual([{ id: 1, qr: db.chains[0].qr, _internal: true }]);
    expect(db.chains[0].qr).toMatch(/^data:image\/png;base64,/);
  });

  it('accepted with remarks: registered all the same, so it gets its QR too', async () => {
    axios.mockResolvedValue({ status: 200, data: ACCEPTED_WITH_REMARKS });
    await send();

    expect(db.chains[0].state).toBe('okwitherrors');
    expect(invoiceUpdates).toHaveLength(1);
  });

  it('rejected: the row is ko, the invoice gets no QR and the run stops there', async () => {
    axios.mockResolvedValue({ status: 200, data: REJECTED });
    db.chains.push(chain(12, 'pending', invoice(2, '2026-0043')));
    await send();

    expect(db.chains[0]).toMatchObject({ state: 'ko', response_text: REJECTED });
    expect(invoiceUpdates).toEqual([]);
    // later records would hash onto a rejected one
    expect(axios).toHaveBeenCalledTimes(1);
    expect(db.chains[1].state).toBe('pending');
  });

  it('an answer that is not a 200 counts as rejected, whatever it says', async () => {
    axios.mockResolvedValue({ status: 202, data: ACCEPTED });
    await send();

    expect(db.chains[0].state).toBe('ko');
    expect(invoiceUpdates).toEqual([]);
  });

  it('a rejected record is sent again on the next run', async () => {
    axios.mockResolvedValueOnce({ status: 200, data: REJECTED });
    await send();
    await send();

    expect(axios).toHaveBeenCalledTimes(2);
    expect(db.chains[0].state).toBe('ok');
  });

  it('AEAT out of reach: the row stays pending and nothing is thrown at the invoice save', async () => {
    axios.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(send()).resolves.toBeUndefined();
    expect(db.chains[0].state).toBe('pending');
    expect(invoiceUpdates).toEqual([]);
  });

  it('no certificate: nothing is sent and the row stays pending', async () => {
    for (const certificate of [null, { url: '/uploads/missing.p12' }]) {
      db.verifactu.certificate = certificate;
      await send();
    }

    expect(axios).not.toHaveBeenCalled();
    expect(db.chains[0].state).toBe('pending');
  });

  it('writes the chain rows as internal, so the writes do not start another run', async () => {
    await send();

    expect(chainUpdates.length).toBeGreaterThan(0);
    expect(chainUpdates.every((u) => u._internal === true)).toBe(true);
  });
});

describe('what is not sent', () => {
  it('nothing when VeriFactu is off or not configured', async () => {
    for (const verifactu of [null, { mode: 'off' }, {}]) {
      db.verifactu = verifactu;
      await send();
    }

    expect(axios).not.toHaveBeenCalled();
  });

  it('an invoice without client or without serie is skipped with a warning, the others go on', async () => {
    db.chains = [
      chain(11, 'pending', invoice(1, '2026-0042', { contact: null })),
      chain(12, 'pending', invoice(2, '2026-0043', { serial: null })),
      chain(13, 'pending', invoice(3, '2026-0044')),
    ];
    await send();

    expect(warnings).toHaveLength(2);
    expect(axios).toHaveBeenCalledTimes(1);
    expect(tag(sentXml(), 'NumSerieFactura')).toBe('2026-0044');
  });

  it('rows already accepted', async () => {
    db.chains = [chain(11, 'ok', invoice(1, '2026-0042'), { hash: 'H' })];
    await send();

    expect(axios).not.toHaveBeenCalled();
  });
});

describe('when a run starts', () => {
  it('on a user edit of a chain row, but not on the internal writes of a run', async () => {
    await lifecycles.afterUpdate({ params: { data: { _internal: true } } });
    expect(axios).not.toHaveBeenCalled();

    await lifecycles.afterUpdate({ params: { data: { actions: 'replacement' } } });
    expect(axios).toHaveBeenCalledTimes(1);
  });
});
