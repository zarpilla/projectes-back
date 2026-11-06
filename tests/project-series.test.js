'use strict';

/**
 * Project series («Sèries de projecte», 2026-11-06): a series numbers the
 * projects that take it, «[2026-001] Nom»; the text stays in `title`, and
 * `name` (what the whole app shows, unique) is the code plus the text. The
 * last project sent to the trash gives its number back; one in the middle
 * leaves a gap. The copy of a project goes into the series it is given.
 */

const SERIE = { id: 3, name: '2026', prefix: '[', suffix: ']', leading_zeros: 3, last_number: 0 };
const OTHER = { id: 4, name: 'OBR', prefix: '', suffix: '', leading_zeros: 2, last_number: 9 };

describe('project series', () => {
  let series;
  let projects;
  let service;

  // a knex-like table of the series, enough for takeNumber / giveBackNumber
  const trx = (table) => {
    expect(table).toBe('project_series');
    let rows = Object.values(series);
    const q = {
      where(where) {
        rows = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        return q;
      },
      forUpdate: () => q,
      first: async () => rows[0],
      update: async (data) => {
        rows.forEach((r) => Object.assign(r, data));
        return rows.length;
      },
    };
    return q;
  };

  beforeEach(() => {
    jest.resetModules();
    series = { 3: { ...SERIE }, 4: { ...OTHER } };
    projects = {};
    global.strapi = {
      db: {
        transaction: async (fn) => fn({ trx }),
        query: (uid) => ({
          findOne: async ({ where }) => {
            if (uid === 'api::project-serie.project-serie') return series[where.id] ? { ...series[where.id] } : null;
            const p = projects[where.id];
            return p ? { ...p, project_serie: p.serie ? { id: p.serie } : null } : null;
          },
        }),
      },
    };
    service = require('../src/api/project/services/project-series');
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('writes the code with the prefix, the zeros and the suffix', () => {
    expect(service.serieCode(SERIE, 1)).toBe('[2026-001]');
    expect(service.serieCode({ name: '2026', leading_zeros: 3 }, 12)).toBe('2026-012');
    expect(service.serieCode({ name: 'P', prefix: '(', suffix: ')', leading_zeros: 0 }, 7)).toBe('(P-7)');
    expect(service.serieProjectName(SERIE, 1, '  Acompanyament  ')).toBe('[2026-001] Acompanyament');
  });

  it('reads the series a request sets in every shape', () => {
    expect(service.requestedSerie({})).toBeUndefined();
    expect(service.requestedSerie({ project_serie: null })).toBeNull();
    expect(service.requestedSerie({ project_serie: { id: 0 } })).toBeNull();
    expect(service.requestedSerie({ project_serie: 3 })).toBe(3);
    expect(service.requestedSerie({ project_serie: { id: '3' } })).toBe(3);
    expect(service.requestedSerie({ project_serie: { connect: [{ id: 3 }] } })).toBe(3);
    expect(service.requestedSerie({ project_serie: { disconnect: [{ id: 3 }] } })).toBeNull();
  });

  it('numbers new projects one after the other', async () => {
    const a = { name: 'Acompanyament', project_serie: { id: 3 }, serie_number: 99 };
    await service.numberNewProject(a);
    expect(a).toMatchObject({ project_serie: 3, serie_number: 1, title: 'Acompanyament', name: '[2026-001] Acompanyament' });
    const b = { name: 'ignored', title: 'Formació', project_serie: 3 };
    await service.numberNewProject(b);
    expect(b.name).toBe('[2026-002] Formació');
    expect(series[3].last_number).toBe(2);
  });

  it('continues the numbering the admin set', async () => {
    const p = { title: 'Obra', project_serie: 4 };
    await service.numberNewProject(p);
    expect(p.name).toBe('OBR-10 Obra');
  });

  it('leaves a project without series as typed, and never takes a number from the request', async () => {
    const p = { name: 'Lliure', serie_number: 5 };
    await service.numberNewProject(p);
    expect(p).toEqual({ name: 'Lliure' });
  });

  it('recomposes the name when the text changes, keeping the number', async () => {
    series[3].last_number = 4;
    projects[10] = { id: 10, name: '[2026-004] Vell', title: 'Vell', serie_number: 4, serie: 3, trashed: false };
    const data = { name: '[2026-004] Vell', title: 'Nou', project_serie: { id: 3 } };
    await service.numberUpdatedProject(10, data);
    expect(data).toMatchObject({ name: '[2026-004] Nou', serie_number: 4, title: 'Nou' });
    expect(series[3].last_number).toBe(4);
  });

  it('takes the text out of a name edited alone', async () => {
    projects[10] = { id: 10, name: '[2026-004] Vell', title: 'Vell', serie_number: 4, serie: 3, trashed: false };
    const edited = { name: '[2026-004] Nou' };
    await service.numberUpdatedProject(10, edited);
    expect(edited).toMatchObject({ name: '[2026-004] Nou', title: 'Nou' });
    const retyped = { name: 'Un altre' };
    await service.numberUpdatedProject(10, retyped);
    expect(retyped.name).toBe('[2026-004] Un altre');
  });

  it('numbers an existing project that takes a series, from its name', async () => {
    projects[11] = { id: 11, name: 'Projecte antic', title: null, serie_number: null, serie: null, trashed: false };
    const data = { name: 'Projecte antic', project_serie: 3 };
    await service.numberUpdatedProject(11, data);
    expect(data).toMatchObject({ name: '[2026-001] Projecte antic', title: 'Projecte antic', serie_number: 1, project_serie: 3 });
  });

  it('moving to another series takes its number and gives the old one back when last', async () => {
    series[3].last_number = 4;
    projects[10] = { id: 10, name: '[2026-004] Obra', title: 'Obra', serie_number: 4, serie: 3, trashed: false };
    const data = { title: 'Obra', project_serie: 4 };
    await service.numberUpdatedProject(10, data);
    expect(data).toMatchObject({ name: 'OBR-10 Obra', serie_number: 10, project_serie: 4 });
    expect(series[3].last_number).toBe(3);
  });

  it('out of the series, the name is the text', async () => {
    series[3].last_number = 4;
    projects[10] = { id: 10, name: '[2026-004] Obra', title: 'Obra', serie_number: 4, serie: 3, trashed: false };
    const data = { title: 'Obra', project_serie: null };
    await service.numberUpdatedProject(10, data);
    expect(data).toMatchObject({ name: 'Obra', serie_number: null, project_serie: null });
    expect(series[3].last_number).toBe(3);
  });

  it('the last project sent to the trash gives its number back', async () => {
    series[3].last_number = 5;
    projects[10] = { id: 10, name: '[2026-005] Obra', title: 'Obra', serie_number: 5, serie: 3, trashed: false };
    await service.numberUpdatedProject(10, { trashed: true });
    expect(series[3].last_number).toBe(4);
    const next = { title: 'Nova', project_serie: 3 };
    await service.numberNewProject(next);
    expect(next.name).toBe('[2026-005] Nova');
  });

  it('one in the middle leaves a gap', async () => {
    series[3].last_number = 5;
    projects[10] = { id: 10, name: '[2026-003] Obra', title: 'Obra', serie_number: 3, serie: 3, trashed: false };
    await service.numberUpdatedProject(10, { trashed: true });
    expect(series[3].last_number).toBe(5);
  });

  it('a project deleted for good gives its number back when last', async () => {
    series[3].last_number = 2;
    await service.releaseDeletedProject({ id: 1, serie_number: 2, trashed: false, project_serie: { id: 3 } });
    expect(series[3].last_number).toBe(1);
    // already in the trash: the number went back then
    await service.releaseDeletedProject({ id: 2, serie_number: 1, trashed: true, project_serie: { id: 3 } });
    expect(series[3].last_number).toBe(1);
  });

  it('an update that touches nothing of the name reads nothing', async () => {
    const findOne = jest.spyOn(global.strapi.db, 'query');
    await service.numberUpdatedProject(10, { description: 'x' });
    expect(findOne).not.toHaveBeenCalled();
  });
});
