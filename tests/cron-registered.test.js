'use strict';

/**
 * Strapi 5 runs only the cron jobs listed in server.cron.tasks. They were defined in
 * config/cron.js but never listed there, so no job ran in v5 (daily task digest,
 * totals refresh, FACe status and retries).
 */
const path = require('path');

describe('cron jobs', () => {
  it('server.cron.tasks holds the jobs of config/cron.js', () => {
    const env = Object.assign((key, def) => (process.env[key] === undefined ? def : process.env[key]), {
      bool: (key, def) => (process.env[key] === undefined ? def : process.env[key] === 'true'),
      int: (key, def) => (process.env[key] === undefined ? def : Number(process.env[key])),
      array: (key, def) => (process.env[key] === undefined ? def : process.env[key].split(',')),
    });
    const server = require(path.join(__dirname, '..', 'config', 'server.js'))({ env });
    const cron = require(path.join(__dirname, '..', 'config', 'cron.js'));
    expect(server.cron.tasks).toBe(cron);
    expect(Object.keys(server.cron.tasks)).toEqual(expect.arrayContaining(['0 3 * * *', '*/2 * * * *']));
  });
});
