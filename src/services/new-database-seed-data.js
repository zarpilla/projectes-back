'use strict';

/**
 * What a brand-new instance starts with (services/seed-new-database.js).
 *
 * Taken from the `buida` tenant, the empty instance new projects used to be
 * restored from (2026-10-11): its catalogs, the settings record and the home
 * menu. Left out on purpose: its users and admin users (personal accounts),
 * the logo file, API tokens, and the years / invoice series / dated holidays
 * that are computed from the current year instead.
 */

// Collection types, in creation order: uid -> rows.
const CATALOGS = {
  // Activity types start empty: each instance defines its own.
  'api::activity-type.activity-type': [],
  'api::contact-type.contact-type': [{ name: 'Clienta' }, { name: 'Proveïdora' }],
  'api::dedication-type.dedication-type': [{ name: 'Facturable' }, { name: 'Gestió Interna' }],
  'api::document-type.document-type': [
    { name: 'Altres', type: 'income', trashed: false },
    { name: 'Subvenció rebuda', type: 'income', trashed: false },
    { name: 'Altres', type: 'expense', trashed: false },
    { name: 'Dieta', type: 'expense', trashed: false },
    { name: 'Tiquet', type: 'expense', trashed: false },
    { name: 'Complement Salarial', type: 'expense', trashed: false },
  ],
  'api::expense-type.expense-type': [
    { name: 'Dietes', vat_pct: 21 },
    { name: 'Serveis Externs', vat_pct: 21 },
    { name: 'Transport', vat_pct: 21 },
    { name: 'Compres', vat_pct: 21 },
    { name: "Ma d'obra", vat_pct: 0 },
    { name: 'Quotes', vat_pct: 0 },
    { name: 'Comissions bancàries', vat_pct: 0 },
    { name: "Ajustament salarial final d'any", vat_pct: 0 },
  ],
  'api::festive-type.festive-type': [
    { name: 'Festiu Estatal', personal: false, max: 8 },
    { name: 'Festiu Catalunya', personal: false, max: 4 },
    { name: 'Festiu Local', personal: true, max: 2 },
    { name: 'Vacances', personal: true, max: 23 },
    { name: 'Lliure Elecció', personal: true, max: 3 },
  ],
  'api::income-type.income-type': [
    { name: 'Factura prestació serveis', vat_pct: 21, trashed: false },
    { name: 'Subvenció pública', vat_pct: 0, trashed: false },
    { name: 'Subvenció privada', vat_pct: 0, trashed: false },
    { name: 'Altres', vat_pct: 21, trashed: false },
  ],
  'api::month.month': [
    'Gener',
    'Febrer',
    'Març',
    'Abril',
    'Maig',
    'Juny',
    'Juliol',
    'Agost',
    'Setembre',
    'Octubre',
    'Novembre',
    'Desembre',
  ].map((name, i) => ({ month: i + 1, name, month_number: String(i + 1).padStart(2, '0') })),
  'api::payment-method.payment-method': [
    {
      name: 'Transferència',
      invoice_text: 'Pagament per transferència bancària al compte corrent: ESXX XXXX XXXX XXXX XXXX',
      default: true,
    },
    { name: 'Efectiu' },
    { name: 'Domiciliació Bancària' },
    { name: 'Paypal' },
  ],
  'api::project-scope.project-scope': [
    { code: 'Àmbit demo 1', name: 'Àmbit demo 1' },
    { code: 'Àmbit demo 2', name: 'Àmbit demo 2' },
  ],
  'api::project-state.project-state': [
    { name: 'Actiu', can_assign_activities: true, can_assign_documents: true },
    { name: 'Tancat', can_assign_documents: false },
    { name: 'Sol·licitat', can_assign_activities: true, can_assign_documents: true },
  ],
  'api::project-type.project-type': [
    { name: 'Standard' },
    { name: 'Propi' },
    { name: 'Urgent' },
    { name: 'Remunerat' },
    { name: 'No remunerat' },
  ],
  'api::region.region': [
    { name: 'Local' },
    { name: 'Comarcal' },
    { name: 'Transcomarcal' },
    { name: 'Nacional' },
    { name: 'Estatal' },
    { name: 'Europeu' },
    { name: 'Internacional' },
  ],
  'api::task-state.task-state': [
    { name: 'Pendents', order: 0 },
    { name: 'En procés', order: 1 },
    { name: 'Acabades', order: 2 },
  ],
  'api::vat-type.vat-type': [{ value: 0 }, { value: 4 }, { value: 10 }, { value: 21 }],
};

// The current year gets a row in `years` and an invoice series named after it.
const YEAR_DEFAULTS = { working_hours: 1760, deductible_vat_pct: 100 };
const SERIE_DEFAULTS = { leadingZeros: 3, emitted_invoice_number: 0 };

// Global holidays: [date, festive type name]. Only those of the current year
// or later are created, so an old list never seeds past dates. Existing
// tenants get a new year's dates from the run-once addOfficialFestives<year>
// in bootstrap (issues/310): add the year here and register it there.
const FESTIVES = [
  ['2026-01-01', 'Festiu Estatal'],
  ['2026-01-06', 'Festiu Estatal'],
  ['2026-04-03', 'Festiu Estatal'],
  ['2026-04-06', 'Festiu Catalunya'],
  ['2026-05-01', 'Festiu Estatal'],
  ['2026-06-24', 'Festiu Catalunya'],
  ['2026-08-15', 'Festiu Estatal'],
  ['2026-09-11', 'Festiu Catalunya'],
  ['2026-10-12', 'Festiu Estatal'],
  ['2026-12-08', 'Festiu Estatal'],
  ['2026-12-25', 'Festiu Estatal'],
  ['2026-12-26', 'Festiu Catalunya'],
  // Calendari oficial de festes laborals a Catalunya 2027 (issues/310)
  ['2027-01-01', 'Festiu Estatal'],
  ['2027-01-06', 'Festiu Estatal'],
  ['2027-03-26', 'Festiu Estatal'],
  ['2027-03-29', 'Festiu Catalunya'],
  ['2027-05-01', 'Festiu Estatal'],
  ['2027-06-24', 'Festiu Catalunya'],
  ['2027-09-11', 'Festiu Catalunya'],
  ['2027-10-12', 'Festiu Estatal'],
  ['2027-11-01', 'Festiu Estatal'],
  ['2027-12-06', 'Festiu Estatal'],
  ['2027-12-08', 'Festiu Estatal'],
  ['2027-12-25', 'Festiu Estatal'],
];

// `me` single type (Configuració General). front_url is added by the seed.
const ME = {
  name: 'DEMO SCCL',
  nif: 'F00000000',
  phone: '',
  email: 'info@demo.coop',
  address: 'Via Laietana, 1',
  city: 'Barcelona',
  postcode: '08001',
  quote_footer: 'DEMO SCCL',
  invoice_footer: 'DEMO SCCL',
  face_test_endpoint: 'https://se-api.face.gob.es/providers',
  face_real_endpoint: 'https://api.face.gob.es/providers',
  options: {
    structural_expenses: true,
    treasury: true,
    user_has_cost_by_hour: true,
    show_estimated_hours_in_phases: true,
    show_tasks_in_gantt: false,
  },
  quotes: {
    autonoma_pct_quota: 0,
    autonoma_quota: 0,
    autonoma_pct_irpf: 15,
    autonoma_pct_other: 0,
    general_pct_quota: 31.65,
    general_quota: 0,
    general_pct_irpf: 0,
    general_pct_other: 6.4,
    diet_amount_total: 0.32,
    diet_amount_without_irpf: 0.26,
  },
  orders_options: { next_day_limit_hour: 13 },
};

// `home-menu` single type: the groups of shortcuts on the front's home page.
const HOME_MENU = [
  {
    name: 'Projectes',
    items: [
      { text: 'Projectes i Estadístiques', navigate: 'projectes' },
      { text: 'Projectes (strapi)', open: 'project' },
    ],
  },
  {
    name: 'Administració',
    items: [
      { text: 'Festius Globals', open: 'festive' },
      { text: "Tipus d'ingressos", open: 'income-type' },
      { text: 'Tipus de documents', open: 'document-type' },
      { text: 'Tipus de festius', open: 'festive-type' },
      { text: 'Anys', open: 'year' },
      { text: 'Mètodes de pagament', open: 'payment-method' },
      { text: 'Sectors', open: 'sector' },
      { text: 'Sèrie', open: 'serie' },
      { text: 'Tipus de dedicació', open: 'dedication-type' },
      { text: 'Tipus de despeses', open: 'expense-type' },
      { text: 'Tipus de projecte', open: 'project-type' },
      { text: 'Tresoreria manual', open: 'treasury' },
      { text: 'Usuàries', open: 'users-permissions.user' },
    ],
  },
  {
    name: 'Ingressos i Despeses',
    items: [
      { text: 'Factures Emeses', open: 'emitted-invoice' },
      { text: 'Altres Ingressos', open: 'received-income' },
      { text: 'Factures Rebudes', open: 'received-invoice' },
      { text: 'Altres Despeses', open: 'received-expense' },
    ],
  },
];

// App permissions of the first user (SEED_USER_EMAIL / SEED_USER_PASSWORD).
const FIRST_USER_PERMISSIONS = ['projects', 'hours', 'admin'];

module.exports = { CATALOGS, YEAR_DEFAULTS, SERIE_DEFAULTS, FESTIVES, ME, HOME_MENU, FIRST_USER_PERMISSIONS };
