'use strict';

/**
 * Serialises a tenant's pm2 `env` block into a .env file.
 *
 * Values MUST be quoted. Two tenants (associaciodidees, ranura) have a `#` in
 * their MySQL password; written bare, dotenv treats everything from the `#` as
 * a comment, so Strapi booted with a truncated password and MySQL answered
 * "Access denied ... (using password: YES)". The v3 app was unaffected because
 * it reads its password from the pm2 env directly and never parses a .env.
 */

// dotenv quoting rules (v16), which are not symmetric:
//   'single'  -> fully literal: no escape processing, `#` and `"` and `\` are safe
//   "double"  -> `\n`/`\r` are expanded, but `\"` and `\\` are NOT unescaped
// So single quotes are the safe encoding, and JSON.stringify is NOT: it escapes
// `"` as `\"`, which dotenv hands back with the backslash still attached.
const quote = (value) => {
  if (!value.includes("'")) return `'${value}'`;
  // A single quote cannot be escaped inside single quotes. Double quotes work
  // as long as the value has nothing dotenv would mangle on the way back.
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new Error(
    "value contains both a single quote and a double quote or backslash, " +
      "which .env cannot represent unambiguously — change the secret"
  );
};

const serializeEnv = (env) =>
  Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== null)
    .map((k) => `${k}=${quote(String(env[k]))}`)
    .join('\n') + '\n';

module.exports = { serializeEnv };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const [configFile, outFile] = process.argv.slice(2);
  if (!configFile || !outFile) {
    console.error('usage: write-env.js <pm2-config.js> <out .env path>');
    process.exit(1);
  }
  const env = require(path.resolve(configFile)).apps[0].env || {};
  fs.writeFileSync(outFile, serializeEnv(env), { mode: 0o600 });
}
