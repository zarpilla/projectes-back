'use strict';

/**
 * prepare failed for associaciodidees and ranura with
 *   Access denied for user 'ranura'@'localhost' (using password: YES)
 * while the v3 app kept running on the same credentials.
 *
 * Their MySQL passwords contain `#`. vps-migrate-tenant.sh wrote the tenant
 * .env as bare `KEY=value`, so dotenv read everything from the `#` onwards as
 * a comment and Strapi connected with a truncated password. v3 was immune: it
 * takes its password straight from the pm2 env and never parses a .env.
 */

const dotenv = require('dotenv');
const { serializeEnv } = require('../tools/migration/write-env');

const roundTrip = (env) => dotenv.parse(serializeEnv(env));

describe('tenant .env serialisation', () => {
  it('survives a # in the password — the reported failure', () => {
    const env = { DATABASE_PASSWORD: 'ab12#xy34$zq56!!', DATABASE_USERNAME: 'ranura' };
    expect(roundTrip(env)).toEqual(env);
  });

  it('would have been truncated by the old bare KEY=value form', () => {
    const bare = 'DATABASE_PASSWORD=ab12#xy34\n';
    expect(dotenv.parse(bare).DATABASE_PASSWORD).toBe('ab12');   // the bug
  });

  it('round-trips the other characters a generated secret can contain', () => {
    const env = {
      APP_KEYS: 'a+b/c==,d+e/f==,g+h/i==',
      SECRETS_KEY: 'deadbeef00112233445566778899aabbccddeeff',
      SMTP_PASS: 'double "quote" and space',
      URL: 'https://example.org/path?a=1&b=2',
      BACKSLASH: 'a\\b',
      EMPTY: '',
    };
    expect(roundTrip(env)).toEqual(env);
  });

  it('handles a value containing a single quote', () => {
    const env = { SMTP_PASS: "it's a secret" };
    expect(roundTrip(env)).toEqual(env);
  });

  it('preserves a real newline inside a value', () => {
    const env = { KEY_PEM: 'line1\nline2' };
    expect(roundTrip(env)).toEqual(env);
  });

  it('refuses a value .env cannot represent rather than corrupting it', () => {
    expect(() => serializeEnv({ P: `both ' and "` }))
      .toThrow(/cannot represent unambiguously/);
  });

  it('keeps every key and drops null/undefined', () => {
    const parsed = roundTrip({ A: '1', B: undefined, C: null, D: '4' });
    expect(Object.keys(parsed).sort()).toEqual(['A', 'D']);
  });

  it('writes numbers and booleans from the pm2 config as strings', () => {
    expect(roundTrip({ DATABASE_POOL_MAX: 8, IS_PROXIED: true }))
      .toEqual({ DATABASE_POOL_MAX: '8', IS_PROXIED: 'true' });
  });
});
