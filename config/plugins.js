/**
 * v5 plugin config. Ported from v3 config/plugins.js.
 *
 * Email provider is switchable via EMAIL_PROVIDER (sendgrid | nodemailer), matching
 * the v3 convention. Both go through `@strapi/provider-email-nodemailer`; SendGrid
 * through its SMTP relay. v5 loads a provider by name only (it lowercases
 * `provider` and resolves it as a package), so a local provider module cannot be
 * plugged in here.
 *
 * v5 reads a plugin's settings from `<plugin>.config`. The email settings used to
 * sit directly under `email`, so v5 ignored them and fell back to its default
 * `sendmail` provider: every tenant delivered straight from the VPS to the
 * recipient's MX instead of through the tenant's SMTP account, and an email sent
 * with only `text` went out as text/plain alone.
 */
const path = require('path');

// PKCS#12 keystores, uploaded into me.face_certificate and verifactu.certificate.
// Both e-invoicing paths consume this format and only this format —
// https.Agent({ pfx }), forge.pkcs12 and `openssl pkcs12` — so the list stays
// narrow rather than opening up certificates generally. `.p12` and `.pfx` both
// resolve to application/x-pkcs12; application/pkcs12 is the IANA name that
// some clients send instead.
const allowedCertificateTypes = ['application/x-pkcs12', 'application/pkcs12'];

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
  ...allowedCertificateTypes,
];

const deniedExecutableTypes = [
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

function emailProviderConfig(env) {
  const provider = env('EMAIL_PROVIDER', 'nodemailer');
  const defaultFrom = env('EMAIL_FROM', 'no-reply@example.com');

  if (provider === 'sendgrid') {
    // NOTE(R8): v3 used strapi-provider-email-sendgrid (v3-only package).
    // SendGrid's SMTP relay takes the literal user `apikey` and the API key as
    // password.
    return {
      provider: 'nodemailer',
      providerOptions: {
        host: 'smtp.sendgrid.net',
        port: 465,
        auth: { user: 'apikey', pass: env('SENDGRID_API_KEY') },
      },
      settings: { defaultFrom, defaultReplyTo: defaultFrom },
    };
  }

  // default: nodemailer (SMTP) — matches production deployment
  return {
    provider: 'nodemailer',
    providerOptions: {
      host: env('SMTP_HOST', 'smtp.example.com'),
      port: env.int('SMTP_PORT', 465),
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    },
    settings: { defaultFrom, defaultReplyTo: defaultFrom },
  };
}

module.exports = ({ env }) => ({
  email: {
    config: emailProviderConfig(env),
  },
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  upload: {
    config: {
      // Local provider (default). v3 also used local; production stores files on disk
      // under public/uploads and serves them via nginx. Multi-tenant: each PM2 instance
      // has its own uploads dir.
      providerOptions: {
        localServer: {
          path: path.resolve(__dirname, '..', 'public', 'uploads'),
        },
      },
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes: deniedExecutableTypes,
      },
    },
  },
});
