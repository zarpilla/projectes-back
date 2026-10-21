'use strict';

/**
 * issues/307 (2026-10-21): the read cache goes to production checking 5 % of
 * its hits against the database by default, so a change it failed to see shows
 * in the logs («[read-cache] STALE entry»). READ_CACHE_VERIFY still decides.
 */

const KEY = Symbol.for('esstrapis.readCache.cache');

describe('READ_CACHE_VERIFY default', () => {
  const saved = process.env.READ_CACHE_VERIFY;

  beforeEach(() => {
    jest.resetModules();
    delete globalThis[KEY];
  });

  afterEach(() => {
    delete globalThis[KEY];
    if (saved === undefined) delete process.env.READ_CACHE_VERIFY;
    else process.env.READ_CACHE_VERIFY = saved;
  });

  it('checks 5 % of the hits when not set', () => {
    delete process.env.READ_CACHE_VERIFY;
    expect(require('../src/services/read-cache').getReadCache().verifyRate).toBe(0.05);
  });

  it('follows the setting, 0 included', () => {
    process.env.READ_CACHE_VERIFY = '0';
    expect(require('../src/services/read-cache').getReadCache().verifyRate).toBe(0);
    delete globalThis[KEY];
    jest.resetModules();
    process.env.READ_CACHE_VERIFY = '1';
    expect(require('../src/services/read-cache').getReadCache().verifyRate).toBe(1);
  });
});
