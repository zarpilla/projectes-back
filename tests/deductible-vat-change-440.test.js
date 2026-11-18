'use strict';

/**
 * issues/440 (2026-11-16, Núria Social Coop): «Tenim activada la prorrata al
 * 67 % però no se suma el 33 % d'IVA no deduïble ni als projectes ni als
 * informes». Configuració had 67 %, but every year in Taules auxiliars › Anys
 * had 100 % (filled by issues/338), and a year's own % rules. Fixing the % in
 * a year (or in Configuració) didn't recompute the stored project totals
 * either (project_totals, issues/328). Guards: an actual change of the % of a
 * year or of Configuració marks every project dirty; saving without changing
 * it (Configuració is saved whole) doesn't.
 */

const mockMarkAllDirty = jest.fn(async () => 9);
const mockRederive = jest.fn(async () => {});
jest.mock('../src/api/project/services/project-totals', () => ({ markAllDirty: (...a) => mockMarkAllDirty(...a) }));
jest.mock('../src/services/dedication-cost', () => ({ rederiveYear: (...a) => mockRederive(...a) }));
jest.mock('../src/services/secret-crypto', () => ({ encryptSecretFields: () => {} }));
jest.mock('../src/services/time-zone', () => ({ setTimeZone: () => {} }));
jest.mock('../src/services/integration-tokens', () => ({ dropTokensOfMovedUrls: async () => {} }));

let stored;
beforeEach(() => {
  jest.resetModules();
  mockMarkAllDirty.mockClear();
  mockRederive.mockClear();
  stored = { year: { year: 2026, deductible_vat_pct: 100 }, me: { options: { deductible_vat_pct: 67 } } };
  global.strapi = {
    log: { info: () => {} },
    db: {
      query: (uid) => ({
        findOne: async () => (uid === 'api::year.year' ? stored.year : stored.me),
      }),
    },
  };
});

// runs before → (the write) → after with one shared event, as Strapi does
const run = async (lifecycles, data, result) => {
  const event = { params: { where: { id: 1 }, data }, state: {} };
  await lifecycles.beforeUpdate(event);
  event.result = result;
  await lifecycles.afterUpdate(event);
};

describe('year «% IVA deduïble» (issues/440)', () => {
  const yearLifecycles = () => require('../src/api/year/content-types/year/lifecycles');

  it('recomputes the projects when it changes', async () => {
    await run(yearLifecycles(), { deductible_vat_pct: 67 }, { year: 2026, deductible_vat_pct: 67 });
    expect(mockMarkAllDirty).toHaveBeenCalledTimes(1);
  });

  it('does nothing when saved with the same % or without it', async () => {
    await run(yearLifecycles(), { deductible_vat_pct: '100.00' }, { year: 2026, deductible_vat_pct: 100 });
    await run(yearLifecycles(), { working_hours: 1700 }, { year: 2026, working_hours: 1700, deductible_vat_pct: 100 });
    expect(mockMarkAllDirty).not.toHaveBeenCalled();
    expect(mockRederive).toHaveBeenCalledWith(2026, 1700);
  });

  it('recomputes when a new year comes with its own %', async () => {
    await yearLifecycles().afterCreate({ params: { data: { year: 2028, deductible_vat_pct: 67 } }, result: { year: 2028, working_hours: 1700, deductible_vat_pct: 67 } });
    expect(mockMarkAllDirty).toHaveBeenCalledTimes(1);
  });
});

describe('Configuració «% IVA deduïble» (issues/440)', () => {
  const meLifecycles = () => require('../src/api/me/content-types/me/lifecycles');

  it('recomputes the projects when it changes', async () => {
    await run(meLifecycles(), { name: 'Coop', options: { id: 1, deductible_vat_pct: 50 } }, { name: 'Coop' });
    expect(mockMarkAllDirty).toHaveBeenCalledTimes(1);
  });

  it('a whole save with the same % does nothing', async () => {
    await run(meLifecycles(), { name: 'Coop', options: { id: 1, deductible_vat_pct: 67 } }, { name: 'Coop' });
    await run(meLifecycles(), { name: 'Coop' }, { name: 'Coop' });
    expect(mockMarkAllDirty).not.toHaveBeenCalled();
  });
});
