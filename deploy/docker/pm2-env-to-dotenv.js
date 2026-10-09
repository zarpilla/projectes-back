#!/usr/bin/env node
// Prints a tenant's environment, taken from its PM2 config, as a Docker Compose
// env file. Values are single-quoted so Compose takes them literally (no $
// interpolation). PATH is left out: the image has its own.
//
//   node pm2-env-to-dotenv.js ~/pm2-apps/strapi-projectes-demo-v5.config.js > envs/demo.env
'use strict';
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: pm2-env-to-dotenv.js <pm2 config.js>');
  process.exit(1);
}
const env = require(path.resolve(file)).apps[0].env || {};
const SKIP = new Set(['PATH']);
const lines = [`# Generated from ${path.basename(file)} on ${new Date().toISOString()} — edit the PM2 config, not this file.`];
for (const [key, raw] of Object.entries(env)) {
  if (SKIP.has(key)) continue;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Bad variable name: ${key}`);
  const value = String(raw);
  if (value.includes("'") || /[\r\n]/.test(value)) throw new Error(`${key}: value with a quote or newline is not supported`);
  lines.push(`${key}='${value}'`);
}
process.stdout.write(lines.join('\n') + '\n');
