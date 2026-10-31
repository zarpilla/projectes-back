'use strict';

/**
 * issues/378 (security review 2026-10-31): the DIR3, invoice parser and FACe
 * URLs come from Configuració, which an entity admin edits. With
 * `dir3_api_url=http://127.0.0.1:2019/config/?x=` the server called Caddy's
 * admin API on the VPS (network_mode: host) and sent the answer back; the axios
 * error with the decrypted X-API-Key was logged.
 * issues/381: FACe and AEAT were called with `rejectUnauthorized: false`.
 */
const fs = require('fs');
const path = require('path');

describe('outbound URLs (issues/378)', () => {
  let outbound;
  beforeEach(() => {
    jest.resetModules();
    delete process.env.OUTBOUND_ALLOW_PRIVATE;
    outbound = require('../src/services/outbound-url');
  });

  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true],
    ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['::1', true], ['::', true],
    ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true], ['not-an-ip', true],
    ['89.117.62.105', false], ['8.8.8.8', false], ['2a01:4f8::1', false], ['172.32.0.1', false],
  ])('%s private: %s', (ip, expected) => {
    expect(outbound.isPrivateAddress(ip)).toBe(expected);
  });

  it('takes only https URLs to public hosts', () => {
    expect(outbound.checkBaseUrl('https://dir3.esstrapis.org/')).toBe('https://dir3.esstrapis.org');
    expect(outbound.checkBaseUrl(' https://se-api.face.gob.es/providers ')).toBe('https://se-api.face.gob.es/providers');
    for (const bad of ['http://dir3.esstrapis.org', 'https://127.0.0.1:2019', 'https://[::1]/', 'file:///etc/passwd',
      'https://user:pw@dir3.esstrapis.org', 'gopher://x', '', null]) {
      expect(() => outbound.checkBaseUrl(bad)).toThrow(outbound.OutboundUrlError);
    }
  });

  it('refuses a name that resolves to a private address, at connect time', (done) => {
    jest.resetModules();
    jest.doMock('dns', () => ({
      lookup: (host, opts, cb) => cb(null, [{ address: host === 'evil.example' ? '127.0.0.1' : '89.117.62.105', family: 4 }]),
    }));
    const { publicLookup } = require('../src/services/outbound-url');
    publicLookup('evil.example', {}, (error) => {
      expect(error && error.name).toBe('OutboundUrlError');
      publicLookup('dir3.esstrapis.org', {}, (err2, address, family) => {
        expect(err2).toBeNull();
        expect([address, family]).toEqual(['89.117.62.105', 4]);
        done();
      });
    });
  });

  describe('DIR3 proxy', () => {
    let axios;
    let ctrl;
    let logged;
    const ctx = (params = { nif: 'Q0801175A' }, query = {}) => ({
      params,
      query,
      state: {},
      badRequest: jest.fn((m) => ({ bad: m })),
      internalServerError: jest.fn((m) => ({ ise: m })),
      send: jest.fn((body, status) => ({ body, status })),
    });

    function load(me) {
      jest.resetModules();
      jest.doMock('axios', () => ({ get: jest.fn() }));
      jest.doMock('../src/services/me-settings', () => ({ getMe: async () => me, tokenFlags: async () => ({}) }));
      jest.doMock('../src/services/secret-crypto', () => ({ decryptSecret: () => 'SECRET-KEY' }));
      logged = [];
      global.strapi = {
        contentType: () => ({ kind: 'singleType' }),
        log: { error: (...a) => logged.push(a.join(' ')), info() {}, warn() {} },
      };
      axios = require('axios');
      ctrl = require('../src/api/me/controllers/me.js')({ strapi: global.strapi });
    }
    afterEach(() => delete global.strapi);

    it('does not call a loopback URL', async () => {
      load({ dir3_api_url: 'http://127.0.0.1:2019/config/?x=', dir3_api_token: 'x' });
      const c = ctx();
      await ctrl.dir3SearchNif(c);
      expect(axios.get).not.toHaveBeenCalled();
      expect(c.badRequest).toHaveBeenCalled();
    });

    it('calls a public https URL without redirects, the limit encoded', async () => {
      load({ dir3_api_url: 'https://dir3.esstrapis.org', dir3_api_token: 'x' });
      axios.get.mockResolvedValue({ data: { success: true, results: [] } });
      expect(await ctrl.dir3SearchName(ctx({ name: 'Ajuntament' }, { limit: '5&x=1' }))).toEqual({ success: true, results: [] });
      const [url, options] = axios.get.mock.calls[0];
      expect(url).toBe('https://dir3.esstrapis.org/api/search/name/Ajuntament?limit=5%26x%3D1');
      expect(options.maxRedirects).toBe(0);
      expect(options.httpsAgent.options.lookup).toBe(require('../src/services/outbound-url').publicLookup);
    });

    it("keeps the upstream status, not its body, and doesn't log the API key", async () => {
      load({ dir3_api_url: 'https://dir3.esstrapis.org', dir3_api_token: 'x' });
      const error = Object.assign(new Error('Request failed with status code 404'), {
        config: { headers: { 'X-API-Key': 'SECRET-KEY' } },
        response: { status: 404, data: { message: 'Not found', apps: { http: { servers: 'all tenants' } } } },
      });
      axios.get.mockRejectedValue(error);
      const c = ctx();
      const answer = await ctrl.dir3SearchNif(c);
      expect(answer.status).toBe(404);
      expect(JSON.stringify(answer.body)).not.toContain('all tenants');
      expect(answer.body.message).toBe('Not found');
      expect(logged.join('\n')).not.toContain('SECRET-KEY');
    });
  });
});

describe('TLS to AEAT and FACe (issues/381)', () => {
  it('no agent turns certificate checks off', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /rejectUnauthorized\s*:\s*false/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });
});
