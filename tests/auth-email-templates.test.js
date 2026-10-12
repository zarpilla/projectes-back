'use strict';

/**
 * Regression: issues/021 — 2026-10-12, auth/forgot-password answered 500 in
 * production ("Oh oh, hi ha hagut un error...").
 *
 * The request was accepted, but the e-mail went out with the sender Strapi
 * seeds in the users-permissions templates, no-reply@strapi.io, and the
 * tenant's SMTP account refused it (553 "Sender address rejected: not owned by
 * user"). services/ensure-auth-email-templates.js replaces that sender on boot
 * with EMAIL_FROM, or else the SMTP account, and Strapi's English text with
 * the Catalan one.
 */

const path = require('path');

const ENSURE = path.join(__dirname, '..', 'src', 'services', 'ensure-auth-email-templates.js');
const ENV_KEYS = ['EMAIL_FROM', 'SMTP_USER'];

const template = (from) => ({ display: 'x', options: { from, response_email: '', object: 'Nova clau', message: '<%= URL %>?code=<%= TOKEN %>' } });
const strapiTemplate = (from) => ({
  display: 'x',
  options: {
    from,
    response_email: '',
    object: 'Reset password',
    message: '<p>We heard that you lost your password. Sorry about that!</p>\n\n<p><%= URL %>?code=<%= TOKEN %></p>',
  },
});
const strapiSender = () => ({ name: 'Administration Panel', email: 'no-reply@strapi.io' });

function stubStrapi(email) {
  const stored = { email };
  const set = jest.fn(async ({ key, value }) => { stored[key] = value; });
  global.strapi = {
    store: jest.fn(() => ({ get: jest.fn(async ({ key }) => stored[key]), set })),
    log: { info: jest.fn(), warn: jest.fn() },
  };
  return { stored, set };
}

describe('users-permissions e-mail templates (issues/021)', () => {
  const env = {};
  beforeAll(() => ENV_KEYS.forEach((key) => { env[key] = process.env[key]; }));
  beforeEach(() => {
    jest.resetModules();
    ENV_KEYS.forEach((key) => delete process.env[key]);
  });
  afterAll(() => ENV_KEYS.forEach((key) => {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }));

  it("replaces Strapi's sender with EMAIL_FROM in every template", async () => {
    process.env.EMAIL_FROM = 'Projectes <hola@exemple.coop>';
    process.env.SMTP_USER = 'smtp@exemple.coop';
    const { stored } = stubStrapi({ reset_password: template(strapiSender()), email_confirmation: template(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    const from = { name: 'Projectes', email: 'hola@exemple.coop' };
    expect(stored.email.reset_password.options.from).toEqual(from);
    expect(stored.email.email_confirmation.options.from).toEqual(from);
    expect(stored.email.reset_password.options.message).toBe('<%= URL %>?code=<%= TOKEN %>');
  });

  it('takes a bare EMAIL_FROM address', async () => {
    process.env.EMAIL_FROM = 'hola@exemple.coop';
    const { stored } = stubStrapi({ reset_password: template(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(stored.email.reset_password.options.from).toEqual({ name: 'ESSTRAPIS', email: 'hola@exemple.coop' });
  });

  it('falls back to the SMTP account', async () => {
    process.env.SMTP_USER = 'smtp@exemple.coop';
    const { stored } = stubStrapi({ reset_password: template(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(stored.email.reset_password.options.from).toEqual({ name: 'ESSTRAPIS', email: 'smtp@exemple.coop' });
  });

  it('keeps a sender set by hand', async () => {
    process.env.EMAIL_FROM = 'hola@exemple.coop';
    const mine = { name: 'La coop', email: 'info@lacoop.example' };
    const { stored, set } = stubStrapi({ reset_password: template(mine), email_confirmation: template(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(stored.email.reset_password.options.from).toEqual(mine);
    expect(stored.email.email_confirmation.options.from.email).toBe('hola@exemple.coop');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when no template has it', async () => {
    process.env.EMAIL_FROM = 'hola@exemple.coop';
    const { set } = stubStrapi({ reset_password: template({ name: 'La coop', email: 'info@lacoop.example' }) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(set).not.toHaveBeenCalled();
  });

  it('warns when there is no address to use', async () => {
    process.env.SMTP_USER = 'apikey';
    const { set } = stubStrapi({ reset_password: template(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(set).not.toHaveBeenCalled();
    expect(global.strapi.log.warn).toHaveBeenCalled();
  });

  it("puts Strapi's English text in Catalan, keeping the link", async () => {
    const mine = { name: 'La coop', email: 'info@lacoop.example' };
    const { stored } = stubStrapi({ reset_password: strapiTemplate(mine) });
    await require(ENSURE).ensureAuthEmailTemplates();
    const { options } = stored.email.reset_password;
    expect(options.object).toBe('Canvi de la clau de pas');
    expect(options.message).toContain('clau de pas');
    expect(options.message).toContain('<%= URL %>?code=<%= TOKEN %>');
    expect(options.message).not.toContain('We heard');
    expect(options.from).toEqual(mine);
  });

  it('translates even when there is no sender to set', async () => {
    const { stored } = stubStrapi({ reset_password: strapiTemplate(strapiSender()) });
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(stored.email.reset_password.options.object).toBe('Canvi de la clau de pas');
    expect(stored.email.reset_password.options.from).toEqual(strapiSender());
    expect(global.strapi.log.warn).toHaveBeenCalled();
  });

  it('keeps a text written by hand', async () => {
    process.env.EMAIL_FROM = 'hola@exemple.coop';
    const { stored } = stubStrapi({ reset_password: template(strapiSender()) });
    stored.email.reset_password.options.object = 'Nova contrasenya';
    await require(ENSURE).ensureAuthEmailTemplates();
    expect(stored.email.reset_password.options.object).toBe('Nova contrasenya');
    expect(stored.email.reset_password.options.message).toBe('<%= URL %>?code=<%= TOKEN %>');
  });
});
