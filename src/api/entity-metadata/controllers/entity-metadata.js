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

          for (const [attrName, attr] of Object.entries(schema.attributes || {})) {
            // Skip internal timestamp/audit fields.
            if (['created_at', 'updated_at', 'published_at', 'created_by', 'updated_by'].includes(attrName)) {
              continue;
            }
            const entry = {
              type: attr.type,
              required: attr.required || false,
              unique: attr.unique || false,
              default: attr.default,
              label: FIELD_TRANSLATIONS[attrName] || null,
            };
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
        'festive-type': 'festive-types',
        user: 'users',
      };

      return { entities: entitiesMetadata, entityToApiPath: extendedEntityToApiPath };
    } catch (error) {
      console.error('Error in adminEntities:', error);
      return ctx.badRequest('Error fetching entity metadata', { error: error.message });
    }
  },
};
