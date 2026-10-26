'use strict';

/**
 * issues/346: «Zona horària» in Configuració general (me.time_zone). The
 * containers run in UTC; the day a form date is stored as and the late-order
 * limits follow the tenant's zone, Europe/Andorra when empty or unknown, and
 * a change applies as soon as `me` is saved.
 */
describe('the tenant time zone', () => {
  beforeEach(() => jest.resetModules());

  it('is Europe/Andorra when empty or unknown', () => {
    const { validTimeZone } = require('../src/services/time-zone');
    expect(validTimeZone(null)).toBe('Europe/Andorra');
    expect(validTimeZone('')).toBe('Europe/Andorra');
    expect(validTimeZone('Mars/Olympus')).toBe('Europe/Andorra');
    expect(validTimeZone(' Atlantic/Canary ')).toBe('Atlantic/Canary');
  });

  it('applies when `me` is saved, and the stored day follows it', async () => {
    const { currentTimeZone } = require('../src/services/time-zone');
    const { toLocalDay } = require('../src/services/date-fields');
    const lifecycles = require('../src/api/me/content-types/me/lifecycles');
    // 23:30 UTC on the 27th: the 28th in Andorra, still the 27th in the Canaries
    expect(toLocalDay('2026-10-27T23:30:00.000Z')).toBe('2026-10-28');
    await lifecycles.afterUpdate({ result: { id: 1, time_zone: 'Atlantic/Canary' } });
    expect(currentTimeZone()).toBe('Atlantic/Canary');
    expect(toLocalDay('2026-10-27T23:30:00.000Z')).toBe('2026-10-27');
    await lifecycles.afterUpdate({ result: { id: 1, time_zone: null } });
    expect(currentTimeZone()).toBe('Europe/Andorra');
  });

  it('is read from `me` at startup', async () => {
    global.strapi = { db: { query: () => ({ findOne: async () => ({ id: 1, time_zone: 'Europe/Lisbon' }) }) }, log: { warn: jest.fn() } };
    const { loadTimeZone, currentTimeZone } = require('../src/services/time-zone');
    expect(await loadTimeZone()).toBe('Europe/Lisbon');
    expect(currentTimeZone()).toBe('Europe/Lisbon');
    delete global.strapi;
  });
});
