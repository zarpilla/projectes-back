'use strict';
/* global strapi */

/**
 * Project series («Sèries de projecte», 2026-11-06).
 *
 * A series numbers the projects that take it, like the series of the invoices:
 * prefix + name + "-" + number with leading zeros + suffix, so «[2026-001]».
 * A numbered project keeps its text in `title`, and its `name` — what every
 * list, select, report and export shows, and what is unique — is the code
 * followed by the text: «[2026-001] Acompanyament en cultura popular». A
 * project without a series keeps its `name` as typed.
 *
 * The series counts in `last_number`; the admin can set it to continue an
 * existing numbering. A project sent to the trash (the only deletion the app
 * offers) gives its number back when it was the last one; one in the middle
 * leaves a gap.
 *
 * Only the server numbers: `serie_number` and the `name` of a numbered project
 * are written here, whatever the request carries.
 */

const { relationId } = require('../../../services/relation-input');

const SERIE_UID = 'api::project-serie.project-serie';
const PROJECT_UID = 'api::project.project';
const SERIES_TABLE = 'project_series';

/** «[2026-001]»: the code of number `number` of `serie`. */
function serieCode(serie, number) {
  const places = Number(serie.leading_zeros) > 0 ? Number(serie.leading_zeros) : 1;
  return `${serie.prefix || ''}${serie.name}-${String(number).padStart(places, '0')}${serie.suffix || ''}`;
}

/** «[2026-001] Text»: the name of a numbered project. */
function serieProjectName(serie, number, title) {
  const text = String(title || '').trim();
  const code = serieCode(serie, number);
  return text ? `${code} ${text}` : code;
}

/**
 * The series a request sets: undefined when it doesn't touch it, null when it
 * clears it, the id otherwise.
 */
function requestedSerie(data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'project_serie')) return undefined;
  const value = data.project_serie;
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.disconnect) && !value.connect && !value.set) {
    return null;
  }
  const id = relationId(value);
  return id && /^\d+$/.test(String(id)) && Number(id) > 0 ? Number(id) : null;
}

/** The next number of the series, counted under a row lock. */
async function takeNumber(serieId) {
  return strapi.db.transaction(async ({ trx }) => {
    const row = await trx(SERIES_TABLE).where({ id: serieId }).forUpdate().first('last_number');
    if (!row) return null;
    const number = (Number(row.last_number) || 0) + 1;
    await trx(SERIES_TABLE).where({ id: serieId }).update({ last_number: number });
    return number;
  });
}

/** Gives the number back to the series when it is its last one. */
async function giveBackNumber(serieId, number) {
  if (!serieId || !number) return false;
  return strapi.db.transaction(async ({ trx }) => {
    const changed = await trx(SERIES_TABLE)
      .where({ id: serieId, last_number: number })
      .update({ last_number: number - 1 });
    return changed > 0;
  });
}

const loadSerie = (id) => strapi.db.query(SERIE_UID).findOne({ where: { id } });

/**
 * POST /projects: numbers the new project when it takes a series. The text is
 * `title`, or the typed `name` when the form sent no title.
 */
async function numberNewProject(data) {
  delete data.serie_number;
  const serieId = requestedSerie(data);
  if (!serieId) {
    if (serieId === null) data.project_serie = null;
    return;
  }
  const serie = await loadSerie(serieId);
  if (!serie) {
    data.project_serie = null;
    return;
  }
  const title = String(data.title !== undefined && data.title !== null ? data.title : data.name || '').trim();
  const number = await takeNumber(serieId);
  data.project_serie = serieId;
  data.serie_number = number;
  data.title = title;
  data.name = serieProjectName(serie, number, title);
}

/**
 * PUT /projects/:id: keeps the number and the name of a numbered project in
 * step with its series, its text and the trash.
 *  - another series: the old number goes back (when last), a new one is taken;
 *  - no series any more: the name is the text, without the code;
 *  - a new text: the name is recomposed;
 *  - sent to the trash: the number goes back when it was the last one.
 */
async function numberUpdatedProject(id, data) {
  delete data.serie_number;
  const requested = requestedSerie(data);
  const touchesTitle = Object.prototype.hasOwnProperty.call(data, 'title');
  const trashing = data.trashed === true;
  if (requested === undefined && !touchesTitle && !trashing && !Object.prototype.hasOwnProperty.call(data, 'name')) {
    return;
  }
  const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
  const stored = await strapi.db.query(PROJECT_UID).findOne({
    where,
    select: ['id', 'name', 'title', 'serie_number', 'trashed'],
    populate: { project_serie: true },
  });
  if (!stored) return;
  const storedSerieId = stored.project_serie ? stored.project_serie.id : null;
  const serieId = requested === undefined ? storedSerieId : requested;

  if (trashing && !stored.trashed && storedSerieId && stored.serie_number) {
    await giveBackNumber(storedSerieId, stored.serie_number);
  }

  if (!serieId) {
    if (storedSerieId) {
      // out of the series: the code goes, the text stays
      if (!trashing && !stored.trashed) await giveBackNumber(storedSerieId, stored.serie_number);
      data.project_serie = null;
      data.serie_number = null;
      const text = touchesTitle ? data.title : stored.title;
      if (text) data.name = String(text).trim();
    } else if (touchesTitle && !Object.prototype.hasOwnProperty.call(data, 'name') && data.title) {
      data.name = String(data.title).trim();
    }
    return;
  }

  const serie = await loadSerie(serieId);
  if (!serie) {
    delete data.project_serie;
    return;
  }
  // the text: the request's, the stored one, or the old name (a project that
  // had no series)
  let title = touchesTitle ? data.title : stored.title;
  if (!touchesTitle && typeof data.name === 'string' && storedSerieId && stored.serie_number) {
    // only the name was edited (a list's quick edit): its text, without the code
    const code = serieCode(await loadSerie(storedSerieId) || serie, stored.serie_number);
    const name = data.name.trim();
    title = name === code ? '' : name.startsWith(`${code} `) ? name.slice(code.length + 1) : name;
  } else if (title === null || title === undefined || title === '') {
    title = storedSerieId ? '' : (data.name !== undefined ? data.name : stored.name);
  }
  title = String(title || '').trim();

  let number = stored.serie_number;
  if (serieId !== storedSerieId || !number) {
    if (storedSerieId && number && !stored.trashed) await giveBackNumber(storedSerieId, number);
    number = await takeNumber(serieId);
    data.project_serie = serieId;
  }
  data.serie_number = number;
  data.title = title;
  data.name = serieProjectName(serie, number, title);
}

/** A project deleted for good (Strapi admin, support) gives its number back too. */
async function releaseDeletedProject(project) {
  if (!project || project.trashed) return;
  const serieId = project.project_serie && (project.project_serie.id || project.project_serie);
  if (serieId && project.serie_number) await giveBackNumber(Number(serieId), project.serie_number);
}

module.exports = {
  serieCode,
  serieProjectName,
  requestedSerie,
  takeNumber,
  giveBackNumber,
  numberNewProject,
  numberUpdatedProject,
  releaseDeletedProject,
};
