'use strict';

/**
 * issues/440, found 2026-11-19 (while doing issues/436): Configuració saved
 * with another «% IVA deduïble» never recomputed the projects. The check lived
 * in the `me` lifecycles, but Strapi 5 saves the components before them and
 * hands them only `options: { id, __pivot }`, so the % never showed and the
 * projects kept the old prorrata. It now runs as a document-service
 * middleware that reads the % before and after the save.
 */
const path = require('path');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'deductible-vat-change.js');
const TOTALS = path.join(__dirname, '..', 'src', 'api', 'project', 'services', 'project-totals.js');

describe('Configuració «% IVA deduïble» recomputes the projects (issues/440)', () => {
  let pct;
  let markAllDirty;

  beforeEach(() => {
    jest.resetModules();
    pct = 100;
    markAllDirty = jest.fn(async () => 12);
    jest.doMock(TOTALS, () => ({ markAllDirty }));
    global.strapi = {
      db: { query: () => ({ findOne: jest.fn(async () => ({ id: 1, options: { deductible_vat_pct: pct } })) }) },
      log: { info: jest.fn() },
    };
  });

  const save = (data, newPct) => {
    const { remarkOnMePctChange } = require(SERVICE);
    return remarkOnMePctChange({ uid: 'api::me.me', action: 'update', params: { data } }, async () => {
      if (newPct !== undefined) pct = newPct;
      return 'saved';
    });
  };

  test('a new % marks every project dirty', async () => {
    await expect(save({ options: { id: 1, deductible_vat_pct: 77 } }, 77)).resolves.toBe('saved');
    expect(markAllDirty).toHaveBeenCalledTimes(1);
  });

  test('the same % (Configuració is saved whole) does nothing', async () => {
    await save({ options: { id: 1, deductible_vat_pct: '100.00' } }, 100);
    expect(markAllDirty).not.toHaveBeenCalled();
  });

  test('a save without the % and other content types are left alone', async () => {
    await save({ front_url: 'https://x/' });
    const { remarkOnMePctChange } = require(SERVICE);
    await remarkOnMePctChange(
      { uid: 'api::year.year', action: 'update', params: { data: { options: { deductible_vat_pct: 5 } } } },
      async () => {},
    );
    expect(markAllDirty).not.toHaveBeenCalled();
  });
});
