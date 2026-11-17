'use strict';
/* global strapi */

/**
 * The logistics project of a quarter (issues/430): where the month's
 * invoices go, by hand («Facturar») and automatically, with one rule for both.
 *
 * The rule: the project named after the quarter, «4T 2026 - Logística»,
 * «Logística - 2025 - 2T»… (a name with "logística", the year and "<n>T"),
 * not in the trash. Several of the same quarter: the one with «Habilitar
 * facturació automàtica», then the one with phases, then the oldest. The
 * automatic run also needs that project to have the option on.
 *
 * The dates of the project don't count: in la Diligència they overlap
 * («3T 2026 - Logística» till 31/12), the name is what everybody goes by.
 *
 * The office can create the quarter's project in a click: named like the last
 * one, dated the quarter, with one phase «Logística», «Actiu», and with what
 * the last one had (client, type, àmbit, leader, billing, the option). Not
 * its state: the last one may be closed already.
 */
const moment = require('moment');

const PROJECT = 'api::project.project';
const PHASE_NAME = 'Logística';

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** { year, quarter } of a logistics project name, or null. */
function projectQuarter(name) {
  const n = normalize(name);
  if (!n.includes('logistica')) return null;
  const year = n.match(/\b(20\d\d)\b/);
  const quarter = n.match(/\b([1-4])\s*t\b/);
  if (!year || !quarter) return null;
  return { year: Number(year[1]), quarter: Number(quarter[1]) };
}

/** The quarter of a month «YYYY-MM»: { year, quarter, label, date_start, date_end }. */
function quarterOf(month) {
  const [year, m] = String(month).split('-').map(Number);
  const quarter = Math.ceil(m / 3);
  const start = moment({ year, month: (quarter - 1) * 3, day: 1 });
  return {
    year,
    quarter,
    label: `${quarter}T ${year}`,
    date_start: start.format('YYYY-MM-DD'),
    date_end: start.clone().add(2, 'months').endOf('month').format('YYYY-MM-DD'),
  };
}

const key = (q) => q.year * 10 + q.quarter;
const hasPhases = (p) => Number(p.phases || 0) > 0;
// the option first, then a project with phases (one without can't take invoices), then the oldest
const preference = (a, b) =>
  Number(Boolean(b.auto_invoicing)) - Number(Boolean(a.auto_invoicing)) ||
  Number(hasPhases(b)) - Number(hasPhases(a)) ||
  a.id - b.id;

/**
 * The quarter's project among `projects` ({ id, name, auto_invoicing,
 * trashed, phases }): `project` (the one invoices go to), `others` (the rest
 * of the same quarter) and `latest` (the logistics project of the newest
 * quarter, the model of a new one).
 */
function pickQuarterProject(projects, q) {
  const logistics = [];
  for (const p of projects || []) {
    if (!p || p.trashed) continue;
    const pq = projectQuarter(p.name);
    if (pq) logistics.push({ p, q: pq });
  }
  const same = logistics.filter((x) => x.q.year === q.year && x.q.quarter === q.quarter).map((x) => x.p).sort(preference);
  let latest = null;
  for (const x of logistics) {
    if (!latest || key(x.q) > key(latest.q) || (key(x.q) === key(latest.q) && preference(x.p, latest.p) < 0)) latest = x;
  }
  return { project: same[0] || null, others: same.slice(1), latest: latest ? latest.p : null };
}

/**
 * The name of the quarter's new project, following the last one's:
 * «3T 2026 - Logística» → «4T 2026 - Logística», «Logística - 2025 - 2T» →
 * «Logística - 2026 - 4T». Without a model: «4T 2026 - Logística».
 */
function newProjectName(latest, q) {
  const model = latest && projectQuarter(latest.name) ? String(latest.name) : null;
  if (!model) return `${q.quarter}T ${q.year} - ${PHASE_NAME}`;
  return model
    .replace(/\b20\d\d\b/, String(q.year))
    .replace(/\b[1-4](\s*)([tT])\b/, (_, space, t) => `${q.quarter}${space}${t}`)
    .replace(/\s*\*+\s*$/, '')
    .trim();
}

/** Every project with what the rule reads: name, option, trash, number of execution phases. */
async function loadProjects() {
  const projects = await strapi.db.query(PROJECT).findMany({
    select: ['id', 'name', 'auto_invoicing', 'trashed', 'date_start', 'date_end'],
    populate: { project_phases: { select: ['id'] } },
  });
  return (projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    auto_invoicing: Boolean(p.auto_invoicing),
    trashed: Boolean(p.trashed),
    date_start: p.date_start,
    date_end: p.date_end,
    phases: Array.isArray(p.project_phases) ? p.project_phases.length : 0,
  }));
}

const brief = (p) => (p ? { id: p.id, name: p.name, auto_invoicing: Boolean(p.auto_invoicing) } : null);

/** The quarter of `month` and its project, for the screens: what «Facturar» suggests and the panel shows. */
async function quarterProjectFor(month, projects = null) {
  const q = quarterOf(month);
  const list = projects || (await loadProjects());
  const { project, others, latest } = pickQuarterProject(list, q);
  return {
    quarter: q,
    project: brief(project),
    others: others.map(brief),
    latest: brief(latest),
    newName: project ? null : newProjectName(latest, q),
  };
}

const relationId = (v) => (v && typeof v === 'object' ? v.id : v) || null;

/**
 * Creates the quarter's project of `month`, modelled on the last one. Refused
 * (status 409, with the project) when the quarter has one already.
 */
async function createQuarterProject(month) {
  const projects = await loadProjects();
  const found = await quarterProjectFor(month, projects);
  if (found.project) {
    const error = new Error(`Ja hi ha el projecte «${found.project.name}» per al ${found.quarter.label}.`);
    error.status = 409;
    error.project = found.project;
    throw error;
  }
  const name = found.newName;
  const clash = projects.find((p) => normalize(p.name) === normalize(name));
  if (clash) {
    const error = new Error(`Ja hi ha un projecte «${clash.name}»${clash.trashed ? ' a la paperera' : ''}: recupera'l o canvia-li el nom.`);
    error.status = 409;
    throw error;
  }

  const model = found.latest
    ? await strapi.db.query(PROJECT).findOne({
        where: { id: found.latest.id },
        populate: {
          project_type: { select: ['id'] },
          project_scope: { select: ['id'] },
          leader: { select: ['id'] },
          clients: { select: ['id'] },
          default_dedication_type: { select: ['id'] },
          region: { select: ['id'] },
        },
      })
    : null;

  const data = {
    name,
    date_start: found.quarter.date_start,
    date_end: found.quarter.date_end,
    auto_invoicing: Boolean(model && model.auto_invoicing),
  };
  if (model) {
    for (const field of ['project_type', 'project_scope', 'leader', 'default_dedication_type', 'region']) {
      const id = relationId(model[field]);
      if (id) data[field] = id;
    }
    const clients = (model.clients || []).map(relationId).filter(Boolean);
    if (clients.length) data.clients = clients;
    if (model.billing_mode) data.billing_mode = model.billing_mode;
    if (model.invoice_hours_price !== null && model.invoice_hours_price !== undefined) data.invoice_hours_price = model.invoice_hours_price;
  }
  if (!data.billing_mode) data.billing_mode = 'project';
  const states = await strapi.db.query('api::project-state.project-state').findMany({ select: ['id', 'name'] });
  const active = (states || []).find((st) => normalize(st.name).trim() === 'actiu');
  if (active) data.project_state = active.id;

  // the project and its phase, or nothing
  const created = await strapi.db.transaction(async () => {
    const project = await strapi.documents(PROJECT).create({ data });
    const controller = strapi.controller(PROJECT);
    for (const entity of ['project-original-phases', 'project-phases']) {
      await controller.createPhaseWithNested(project.id, entity, { name: PHASE_NAME, position: 0, incomes: [], expenses: [] });
    }
    return project;
  });
  strapi.log.info(`[auto-invoicing] created the project «${name}» (${created.id}) for ${found.quarter.label}`);
  return { quarter: found.quarter, project: { id: created.id, name, auto_invoicing: data.auto_invoicing }, model: brief(found.latest) };
}

module.exports = {
  PHASE_NAME,
  createQuarterProject,
  loadProjects,
  newProjectName,
  pickQuarterProject,
  projectQuarter,
  quarterOf,
  quarterProjectFor,
};
