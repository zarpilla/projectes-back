'use strict';

/**
 * Guards the invoice email body. me.invoice_template is HTML for most tenants
 * (diligencia: `<p>Bon dia {contact_name}, </p>...`); sent as `text`, the
 * nodemailer provider copied it into both MIME parts and customers whose
 * client shows the plain-text part saw the raw `<p>` tags.
 */

const { buildEmailBody, normalizeEmailBody, wrapEmailProvider } = require('../src/services/email-body');

const DILIGENCIA_TEMPLATE = `<p>Bon dia {contact_name}, </p>
<p>
Adjuntem la factura {invoice_code} corresponent a l'últim mes.
</p>
<p>
Moltes gràcies un cop més per apostar per la logística cooperativa amb tot el que
això significa (participació, estalvi, economia al servei de les persones, reducció
de CO2..)
</p>
<p>
Atentament,
</p>
<p>
La Diligència
</p>`;

describe('buildEmailBody', () => {
  it('sends an HTML template as html and a tag-free text alternative', () => {
    const { html, text } = buildEmailBody(DILIGENCIA_TEMPLATE, {
      invoice_code: '2026-230',
      contact_name: 'Lola Puig Gasull',
    });

    expect(html).toContain('<p>Bon dia Lola Puig Gasull, </p>');
    expect(html).toContain('Adjuntem la factura 2026-230');
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).toBe(
      [
        'Bon dia Lola Puig Gasull,',
        "Adjuntem la factura 2026-230 corresponent a l'últim mes.",
        'Moltes gràcies un cop més per apostar per la logística cooperativa amb tot el que\n' +
          'això significa (participació, estalvi, economia al servei de les persones, reducció\n' +
          'de CO2..)',
        'Atentament,',
        'La Diligència',
      ].join('\n\n'),
    );
  });

  it('escapes placeholder values inside an HTML template', () => {
    const { html, text } = buildEmailBody('<p>Hola {contact_name}</p>', { contact_name: 'Pa & <Vi>' });
    expect(html).toBe('<p>Hola Pa &amp; &lt;Vi&gt;</p>');
    expect(text).toBe('Hola Pa & <Vi>');
  });

  it('keeps a plain-text template as text and builds paragraphs for html', () => {
    const { html, text } = buildEmailBody('Hola {contact_name},\n\nFactura {invoice_code}\nGràcies', {
      contact_name: 'Anna',
      invoice_code: 'F-1',
    });
    expect(text).toBe('Hola Anna,\n\nFactura F-1\nGràcies');
    expect(html).toBe('<p>Hola Anna,</p>\n<p>Factura F-1<br>Gràcies</p>');
  });

  it('replaces every occurrence of a placeholder', () => {
    const { text } = buildEmailBody('{invoice_code} / {invoice_code}', { invoice_code: 'X' });
    expect(text).toBe('X / X');
  });

  it('tolerates a missing template', () => {
    expect(buildEmailBody(null, { invoice_code: 'X' })).toEqual({ html: '', text: '' });
  });
});

describe('normalizeEmailBody', () => {
  it('moves HTML passed as text into html and strips the text part', () => {
    const out = normalizeEmailBody({ to: 'a@b.c', text: '<p>Reset: <a href="x">link</a></p>' });
    expect(out).toEqual({ to: 'a@b.c', html: '<p>Reset: <a href="x">link</a></p>', text: 'Reset: link' });
  });

  it('derives a tag-free text part from html-only notifications', () => {
    const out = normalizeEmailBody({ html: '<b>Incidència</b><br><br><b>Comanda:</b> #12<br>' });
    expect(out.html).toBe('<b>Incidència</b><br><br><b>Comanda:</b> #12<br>');
    expect(out.text).toBe('Incidència\n\nComanda: #12');
  });

  it('keeps plain text and adds an html part with its line breaks', () => {
    expect(normalizeEmailBody({ text: 'Hola\nAdéu' })).toEqual({ text: 'Hola\nAdéu', html: '<p>Hola<br>Adéu</p>' });
  });

  it('leaves an explicit text + html pair alone', () => {
    expect(normalizeEmailBody({ text: 'Hola', html: '<p>Hola</p>' })).toEqual({ text: 'Hola', html: '<p>Hola</p>' });
  });
});

describe('wrapEmailProvider', () => {
  it('normalizes every send of the email provider, once', async () => {
    const sent = [];
    const provider = { send: async (options) => sent.push(options) };
    const strapiMock = { plugin: () => ({ provider }) };
    wrapEmailProvider(strapiMock);
    wrapEmailProvider(strapiMock);
    await provider.send({ html: '<p>Hola</p>' });
    expect(sent).toEqual([{ html: '<p>Hola</p>', text: 'Hola' }]);
  });
});

describe('email plugin config', () => {
  // v5 reads `email.config`; without that wrapper it silently used sendmail.
  const load = (vars) => {
    const env = (key, fallback) => (key in vars ? vars[key] : fallback);
    env.int = (key, fallback) => (key in vars ? parseInt(vars[key], 10) : fallback);
    env.bool = (key, fallback) => (key in vars ? vars[key] === 'true' : fallback);
    env.array = (key, fallback) => (key in vars ? vars[key].split(',') : fallback);
    return require('../config/plugins.js')({ env }).email;
  };

  it('nests the SMTP settings under config, with a provider name', () => {
    const email = load({ EMAIL_PROVIDER: 'nodemailer', SMTP_HOST: 'smtp.dondominio.com', SMTP_PORT: '465', EMAIL_FROM: 'g@x.coop' });
    expect(email.config.provider).toBe('nodemailer');
    expect(email.config.providerOptions.host).toBe('smtp.dondominio.com');
    expect(email.config.providerOptions.port).toBe(465);
    expect(email.config.settings.defaultFrom).toBe('g@x.coop');
  });

  it('sends SendGrid through its SMTP relay', () => {
    const email = load({ EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'k' });
    expect(email.config.provider).toBe('nodemailer');
    expect(email.config.providerOptions).toMatchObject({ host: 'smtp.sendgrid.net', auth: { user: 'apikey', pass: 'k' } });
  });
});
