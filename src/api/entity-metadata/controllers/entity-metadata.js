'use strict';

/**
 * entity-metadata controller (v5). Ported from v3 api/entity-metadata/controllers/entity-metadata.js.
 *
 * Returns schema metadata for the admin "entity management" UI — field types, labels
 * (Catalan), relations, validation rules — for a fixed set of lookup content types.
 *
 * Migration: v3 read v3-format settings.json (with model/collection relations) from
 * strapi.dir/api/<ct>/models/. v5 reads v5-format schema.json (with type:'relation',
 * relation, target) from src/api/<singular>/content-types/<singular>/schema.json.
 * The folder names are now singular (e.g. "bank-account", not "bank-accounts").
 */

const fs = require('fs');
const path = require('path');

// Catalan field labels (preserved verbatim from v3).
const FIELD_TRANSLATIONS = {
  code: 'Codi',
  name: 'Nom',
  short_name: 'Nom curt',
  shortName: 'Nom curt',
  full_name: 'Nom complet',
  fullName: 'Nom complet',
  description: 'Descripció',
  year: 'Any',
  username: "Nom d'usuari",
  users_permissions_user: 'Usuària',
  usersPermissionsUser: 'Usuària',
  user: 'Usuària',
  email: 'Correu electrònic',
  active: 'Actiu',
  enabled: 'Activat',
  disabled: 'Desactivat',
  default: 'Per defecte',
  group: 'Grup',
  working_hours: 'Hores de treball',
  workingHours: 'Hores de treball',
  deductible: 'Deduïble',
  deductible_vat_pct: '% IVA deduïble',
  deductibleVatPct: '% IVA deduïble',
  vat: 'IVA',
  pct: 'Percentatge',
  percentage: 'Percentatge',
  start_date: "Data d'inici",
  startDate: "Data d'inici",
  end_date: 'Data de fi',
  endDate: 'Data de fi',
  date: 'Data',
  amount: 'Import',
  quantity: 'Quantitat',
  price: 'Preu',
  total: 'Total',
  notes: 'Notes',
  comments: 'Comentaris',
  status: 'Estat',
  type: 'Tipus',
  festive_type: 'Tipus de festiu',
  festiveType: 'Tipus de festiu',
  category: 'Categoria',
  order: 'Ordre',
  position: 'Posició',
  priority: 'Prioritat',
  color: 'Color',
  icon: 'Icona',
  url: 'URL',
  phone: 'Telèfon',
  address: 'Adreça',
  city: 'Ciutat',
  postal_code: 'Codi postal',
  postalCode: 'Codi postal',
  country: 'País',
  region: 'Regió',
  created_at: 'Creat el',
  createdAt: 'Creat el',
  updated_at: 'Actualitzat el',
  updatedAt: 'Actualitzat el',
  code_name: 'Nom de codi',
  codeName: 'Nom de codi',
  project_scope: 'Àmbit de projecte',
  projectScope: 'Àmbit de projecte',
  // the fields of Taules auxiliars that showed their English name (issues/103)
  can_assign_activities: 'Admet hores',
  can_assign_documents: 'Admet documents',
  projects: 'Projectes',
  iban: 'IBAN',
  invoice_text: 'Text a la factura',
  nameTreasury: 'Nom a tresoreria',
  bank_account: 'Compte bancari',
  leadingZeros: 'Zeros a l\'esquerra',
  emitted_invoice_number: 'Número de factura',
  rectificative: 'Rectificativa',
  vat_pct: '% IVA',
  trashed: 'Esborrat',
  max: 'Màxim de dies',
  // festive types and route rates (issues/140, issues/139)
  personal: 'Personal',
  delivery_type: "Tipus d'entrega",
  pickup: 'Recollida',
  routes: 'Rutes',
  less10: 'Menys de 10 kg',
  more10: 'A 10 kg',
  from10to20: 'A 20 kg',
  from20to30: 'A 30 kg',
  from30to40: 'A 40 kg',
  from40to50: 'A 50 kg',
  from50to60: 'A 60 kg',
  additional60: 'Cada kg de més de 60',
  pickup_point: 'Per línia de punt de recollida',
};

// Help under a field of the admin form.
const FIELD_HELP = {
  'festive-type': {
    personal: "Marcat: cada persona en té els seus dies (vacances, lliure elecció). Sense marcar: festius per a tothom (estatals, autonòmics).",
    max: "Dies a l'any que en té cada persona. Es pot canviar per a una persona a «Festius d'usuari».",
  },
  'route-rate': {
    routes: 'Les rutes on s\'aplica. Sense cap ruta, s\'aplica a totes.',
    pickup: 'Només per a aquesta recollida. Buit: qualsevol.',
    delivery_type: "Només per a aquest tipus d'entrega. Buit: qualsevol.",
    less10: 'Preu fix per a les comandes de menys de 10 kg.',
    more10: 'Preu d\'una comanda de 10 kg. Entre dos trams, el preu es calcula proporcionalment.',
    additional60: 'Per sobre de 60 kg: el preu de 60 kg més aquest import per cada kg de més.',
    pickup_point: 'Se suma per cada línia que va a un punt de recollida.',
  },
};

// Fields left out of the admin screens. Route rates: the tiers of the old rate
// (less15/less30/additional30) are no longer used; every rate is a «ratev2» one
// and the lifecycle keeps new ones so (issues/139).
const HIDDEN_FIELDS = {
  'route-rate': ['less15', 'less30', 'additional30', 'ratev2'],
};

// To-many relations the admin form edits (the others are edited from the other side).
const EDITABLE_COLLECTIONS = {
  'route-rate': ['routes'],
};

// Order of the fields on the admin screens (the ones not listed go after them).
// Route rates: the tiers by weight, as the price is worked out.
const FIELD_ORDER = {
  'route-rate': ['name', 'routes', 'pickup', 'delivery_type', 'less10', 'more10', 'from10to20',
    'from20to30', 'from30to40', 'from40to50', 'from50to60', 'additional60', 'pickup_point'],
};

const orderedAttributes = (singularFolder, attributes) => {
  const order = FIELD_ORDER[singularFolder];
  const entries = Object.entries(attributes || {});
  if (!order) return entries;
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
};

// Admin-manageable entities: v5 singular folder → v5 API plural path.
const ADMIN_ENTITIES = {
  'bank-account': 'bank-accounts',
  'contact-type': 'contact-types',
  'dedication-type': 'dedication-types',
  'expense-type': 'expense-types',
  'income-type': 'income-types',
  'legal-form': 'legal-forms',
  'payment-method': 'payment-methods',
  'project-likelihood': 'project-likelihoods',
  'project-state': 'project-states',
  'project-type': 'project-types',
  region: 'regions',
  'project-scope': 'project-scopes',
  sector: 'sectors',
  serie: 'series',
  'social-entity': 'social-entities',
  strategy: 'strategies',
  'task-state': 'task-states',
  'user-festive': 'user-festives',
  year: 'years',
  'festive-type': 'festive-types',
  'route-rate': 'route-rates',
};

// Catalan display names (singular/plural), preserved verbatim from v3.
const DISPLAY_NAMES = {
  'bank-account': { displayName: 'Comptes bancaris', displayNameSingular: 'Compte bancari' },
  'contact-type': { displayName: 'Tipus de contacte', displayNameSingular: 'Tipus de contacte' },
  'dedication-type': { displayName: 'Tipus de dedicació', displayNameSingular: 'Tipus de dedicació' },
  'expense-type': { displayName: 'Tipus de despesa', displayNameSingular: 'Tipus de despesa' },
  'income-type': { displayName: "Tipus d'ingrés", displayNameSingular: "Tipus d'ingrés" },
  'legal-form': { displayName: 'Formes jurídiques', displayNameSingular: 'Forma jurídica' },
  'payment-method': { displayName: 'Mètodes de pagament', displayNameSingular: 'Mètode de pagament' },
  'project-likelihood': {
    displayName: 'Probabilitats de projecte',
    displayNameSingular: 'Probabilitat de projecte',
  },
  'project-state': { displayName: 'Estats de projecte', displayNameSingular: 'Estat de projecte' },
  'project-type': { displayName: 'Tipus de projecte', displayNameSingular: 'Tipus de projecte' },
  region: { displayName: 'Regions', displayNameSingular: 'Regió' },
  'project-scope': { displayName: 'Àmbits de projecte', displayNameSingular: 'Àmbit de projecte' },
  sector: { displayName: 'Sectors', displayNameSingular: 'Sector' },
  serie: { displayName: 'Sèries', displayNameSingular: 'Sèrie' },
  'social-entity': { displayName: 'Entitats socials', displayNameSingular: 'Entitat social' },
  strategy: { displayName: 'Estratègies', displayNameSingular: 'Estratègia' },
  'task-state': { displayName: 'Estats de tasca', displayNameSingular: 'Estat de tasca' },
  'user-festive': { displayName: "Festius d'usuari", displayNameSingular: "Festiu d'usuari" },
  year: { displayName: 'Anys', displayNameSingular: 'Any' },
  'festive-type': { displayName: 'Tipus de festiu', displayNameSingular: 'Tipus de festiu' },
  'route-rate': { displayName: 'Tarifes de ruta', displayNameSingular: 'Tarifa de ruta' },
};

module.exports = {
  /**
   * GET /api/entity-metadata/admin-entities
   * Returns schema metadata for admin-managed lookup entities.
   * Requires authentication + admin permission (policies set on the route).
   */
  async adminEntities(ctx) {
    try {
      // strapi is a runtime global injected by Strapi; not imported.
      // eslint-disable-next-line no-undef
      const srcApiDir = path.join(strapi.dirs.app.root, 'src', 'api');
      const entitiesMetadata = [];

      for (const [singularFolder, apiPath] of Object.entries(ADMIN_ENTITIES)) {
        try {
          const schemaPath = path.join(
            srcApiDir,
            singularFolder,
            'content-types',
            singularFolder,
            'schema.json',
          );
          if (!fs.existsSync(schemaPath)) {
            console.warn(`Schema not found for entity: ${singularFolder}`);
            continue;
          }
          const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

          const displayNameConfig = DISPLAY_NAMES[singularFolder] || {};
          const fallback = schema.info?.displayName || singularFolder;

          const metadata = {
            name: singularFolder,
            apiPath,
            displayName: displayNameConfig.displayName || fallback,
            displayNameSingular:
              displayNameConfig.displayNameSingular || displayNameConfig.displayName || fallback,
            collectionName: schema.collectionName,
            attributes: {},
          };

          for (const [attrName, attr] of orderedAttributes(singularFolder, schema.attributes)) {
            // Skip internal timestamp/audit fields.
            if (['created_at', 'updated_at', 'published_at', 'created_by', 'updated_by'].includes(attrName)) {
              continue;
            }
            if ((HIDDEN_FIELDS[singularFolder] || []).includes(attrName)) {
              continue;
            }
            const entry = {
              type: attr.type,
              required: attr.required || false,
              unique: attr.unique || false,
              default: attr.default,
              label: FIELD_TRANSLATIONS[attrName] || null,
            };
            const help = (FIELD_HELP[singularFolder] || {})[attrName];
            if (help) entry.help = help;
            if ((EDITABLE_COLLECTIONS[singularFolder] || []).includes(attrName)) entry.editable = true;
            if (attr.type === 'enumeration' && attr.enum) {
              entry.enum = attr.enum;
            }
            if (attr.type === 'relation') {
              // v5 relation shape: { type:'relation', relation, target }
              entry.relation = attr.relation;
              entry.target = attr.target;
            }
            if (attr.min !== undefined) entry.min = attr.min;
            if (attr.max !== undefined) entry.max = attr.max;
            if (attr.minLength !== undefined) entry.minLength = attr.minLength;
            if (attr.maxLength !== undefined) entry.maxLength = attr.maxLength;
            metadata.attributes[attrName] = entry;
          }
          entitiesMetadata.push(metadata);
        } catch (err) {
          console.error(`Error processing entity ${singularFolder}:`, err);
        }
      }

      const extendedEntityToApiPath = {
        ...ADMIN_ENTITIES,
        route: 'routes',
        'delivery-type': 'delivery-types',
        pickup: 'pickups',
        user: 'users',
      };

      return { entities: entitiesMetadata, entityToApiPath: extendedEntityToApiPath };
    } catch (error) {
      console.error('Error in adminEntities:', error);
      return ctx.badRequest('Error fetching entity metadata', { error: error.message });
    }
  },
};
