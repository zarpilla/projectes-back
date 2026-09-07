import type { Schema, Struct } from '@strapi/strapi';

export interface AdminApiToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_tokens';
  info: {
    description: '';
    displayName: 'Api Token';
    name: 'Api Token';
    pluralName: 'api-tokens';
    singularName: 'api-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    adminPermissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    adminUserOwner: Schema.Attribute.Relation<'manyToOne', 'admin::user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    encryptedKey: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    expiresAt: Schema.Attribute.DateTime;
    kind: Schema.Attribute.Enumeration<['content-api', 'admin']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'content-api'>;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> & Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::api-token-permission'>;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.Enumeration<['read-only', 'full-access', 'custom']> &
      Schema.Attribute.DefaultTo<'read-only'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface AdminApiTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_token_permissions';
  info: {
    description: '';
    displayName: 'API Token Permission';
    name: 'API Token Permission';
    pluralName: 'api-token-permissions';
    singularName: 'api-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token-permission'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface AdminPermission extends Struct.CollectionTypeSchema {
  collectionName: 'admin_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'Permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    actionParameters: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    apiToken: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    conditions: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<[]>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::permission'> & Schema.Attribute.Private;
    properties: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'admin::role'>;
    subject: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface AdminRole extends Struct.CollectionTypeSchema {
  collectionName: 'admin_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'Role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::role'> & Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'manyToMany', 'admin::user'>;
  };
}

export interface AdminSession extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_sessions';
  info: {
    description: 'Session Manager storage';
    displayName: 'Session';
    name: 'Session';
    pluralName: 'sessions';
    singularName: 'session';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
    i18n: {
      localized: false;
    };
  };
  attributes: {
    absoluteExpiresAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    childId: Schema.Attribute.String & Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deviceId: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime & Schema.Attribute.Required & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::session'> & Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON & Schema.Attribute.Private;
    origin: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    sessionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique;
    status: Schema.Attribute.String & Schema.Attribute.Private;
    type: Schema.Attribute.String & Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    userId: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Private;
  };
}

export interface AdminTransferToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_tokens';
  info: {
    description: '';
    displayName: 'Transfer Token';
    name: 'Transfer Token';
    pluralName: 'transfer-tokens';
    singularName: 'transfer-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::transfer-token'> & Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::transfer-token-permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface AdminTransferTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_token_permissions';
  info: {
    description: '';
    displayName: 'Transfer Token Permission';
    name: 'Transfer Token Permission';
    pluralName: 'transfer-token-permissions';
    singularName: 'transfer-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::transfer-token-permission'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::transfer-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface AdminUser extends Struct.CollectionTypeSchema {
  collectionName: 'admin_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'User';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    apiTokens: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> & Schema.Attribute.Private;
    blocked: Schema.Attribute.Boolean & Schema.Attribute.Private & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.Private & Schema.Attribute.DefaultTo<false>;
    lastname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::user'> & Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    preferedLanguage: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    registrationToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordTokenExpiresAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    roles: Schema.Attribute.Relation<'manyToMany', 'admin::role'> & Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    username: Schema.Attribute.String;
  };
}

export interface ApiActivityTypeActivityType extends Struct.CollectionTypeSchema {
  collectionName: 'activity_types';
  info: {
    displayName: 'Activity Types';
    pluralName: 'activity-types';
    singularName: 'activity-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    global: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::activity-type.activity-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiActivityActivity extends Struct.CollectionTypeSchema {
  collectionName: 'activities';
  info: {
    displayName: 'Activities';
    pluralName: 'activities';
    singularName: 'activity';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    activity_type: Schema.Attribute.Relation<'oneToOne', 'api::activity-type.activity-type'>;
    cost_by_hour: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    dedication_type: Schema.Attribute.Relation<'oneToOne', 'api::dedication-type.dedication-type'>;
    description: Schema.Attribute.String;
    hours: Schema.Attribute.Decimal;
    invoice_hours_price: Schema.Attribute.Decimal;
    invoiced: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::activity.activity'> &
      Schema.Attribute.Private;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    task: Schema.Attribute.Relation<'oneToOne', 'api::task.task'>;
    uid_ical: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiBankAccountBankAccount extends Struct.CollectionTypeSchema {
  collectionName: 'bank_accounts';
  info: {
    displayName: 'Bank Accounts';
    pluralName: 'bank-accounts';
    singularName: 'bank-account';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    iban: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::bank-account.bank-account'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiCityRouteCityRoute extends Struct.CollectionTypeSchema {
  collectionName: 'city_routes';
  info: {
    displayName: 'CityRoute';
    pluralName: 'city-routes';
    singularName: 'city-route';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    city: Schema.Attribute.Relation<'oneToOne', 'api::city.city'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::city-route.city-route'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    route: Schema.Attribute.Relation<'oneToOne', 'api::route.route'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiCityCity extends Struct.CollectionTypeSchema {
  collectionName: 'cities';
  info: {
    displayName: 'City';
    pluralName: 'cities';
    singularName: 'city';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::city.city'> & Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiConfigConfig extends Struct.SingleTypeSchema {
  collectionName: 'configs';
  info: {
    displayName: 'config';
    pluralName: 'config-setting';
    singularName: 'config';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    front_url: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::config.config'> & Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiContactTypeContactType extends Struct.CollectionTypeSchema {
  collectionName: 'contact_types';
  info: {
    displayName: 'Contact Type';
    pluralName: 'contact-types';
    singularName: 'contact-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::contact-type.contact-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiContactContact extends Struct.CollectionTypeSchema {
  collectionName: 'contacts';
  info: {
    displayName: 'Contacts';
    pluralName: 'contacts';
    singularName: 'contact';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    address: Schema.Attribute.String;
    city: Schema.Attribute.String;
    collection_points: Schema.Attribute.Relation<'oneToMany', 'api::contact.contact'>;
    contact_email: Schema.Attribute.Email;
    contact_person: Schema.Attribute.String;
    contact_phone: Schema.Attribute.String;
    contact_types: Schema.Attribute.Relation<'oneToMany', 'api::contact-type.contact-type'>;
    country: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    email: Schema.Attribute.Email;
    externalId: Schema.Attribute.String;
    externalId2: Schema.Attribute.String;
    face: Schema.Attribute.Boolean;
    face_dir3_oc: Schema.Attribute.String;
    face_dir3_og: Schema.Attribute.String;
    face_dir3_ut: Schema.Attribute.String;
    followup_date: Schema.Attribute.Date;
    is_client: Schema.Attribute.Boolean;
    is_provider: Schema.Attribute.Boolean;
    legal_form: Schema.Attribute.Relation<'oneToOne', 'api::legal-form.legal-form'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::contact.contact'> & Schema.Attribute.Private;
    multidelivery: Schema.Attribute.Boolean;
    multiowner: Schema.Attribute.Boolean;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    nif: Schema.Attribute.String;
    notes: Schema.Attribute.Text;
    notes_delivery: Schema.Attribute.Text;
    owner: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    partner_amount: Schema.Attribute.Decimal;
    partner_amount_date: Schema.Attribute.Date;
    phone: Schema.Attribute.String;
    pickup_discount: Schema.Attribute.Decimal;
    pickup_point: Schema.Attribute.Boolean;
    postcode: Schema.Attribute.String;
    projectes: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sector: Schema.Attribute.Relation<'oneToOne', 'api::sector.sector'>;
    state: Schema.Attribute.String;
    time_slot_1_end: Schema.Attribute.Decimal;
    time_slot_1_ini: Schema.Attribute.Decimal;
    time_slot_2_end: Schema.Attribute.Decimal;
    time_slot_2_ini: Schema.Attribute.Decimal;
    trade_name: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    website: Schema.Attribute.String;
  };
}

export interface ApiDailyDedicationDailyDedication extends Struct.CollectionTypeSchema {
  collectionName: 'daily_dedications';
  info: {
    displayName: 'Calendars';
    pluralName: 'daily-dedications';
    singularName: 'daily-dedication';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    costByHour: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    from: Schema.Attribute.Date;
    hours: Schema.Attribute.Decimal;
    hoursperday: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::daily-dedication.daily-dedication'> &
      Schema.Attribute.Private;
    monthly_salary: Schema.Attribute.Decimal;
    pct_irpf: Schema.Attribute.Decimal;
    pct_other: Schema.Attribute.Decimal;
    pct_quota: Schema.Attribute.Decimal;
    publishedAt: Schema.Attribute.DateTime;
    quota: Schema.Attribute.Decimal;
    scheme: Schema.Attribute.Enumeration<['autonoma', 'general']>;
    to: Schema.Attribute.Date;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'manyToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiDedicationTypeDedicationType extends Struct.CollectionTypeSchema {
  collectionName: 'dedication_types';
  info: {
    displayName: 'Dedication Types';
    pluralName: 'dedication-types';
    singularName: 'dedication-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::dedication-type.dedication-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiDeliveryTypeDeliveryType extends Struct.CollectionTypeSchema {
  collectionName: 'delivery_types';
  info: {
    displayName: 'DeliveryType';
    pluralName: 'delivery-types';
    singularName: 'delivery-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::delivery-type.delivery-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    refrigerated: Schema.Attribute.Boolean;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiDietDiet extends Struct.CollectionTypeSchema {
  collectionName: 'diets';
  info: {
    displayName: 'Diets';
    pluralName: 'diets';
    singularName: 'diet';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.ticket-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::diet.diet'> & Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiDocumentTypeDocumentType extends Struct.CollectionTypeSchema {
  collectionName: 'document_types';
  info: {
    displayName: 'Document Types';
    pluralName: 'document-types';
    singularName: 'document-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::document-type.document-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    trashed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    type: Schema.Attribute.Enumeration<['income', 'expense']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiEmittedGrantEmittedGrant extends Struct.CollectionTypeSchema {
  collectionName: 'emitted_grants';
  info: {
    displayName: 'Emitted Grants';
    pluralName: 'emitted-grants';
    singularName: 'emitted-grant';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_grant_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::emitted-grant.emitted-grant'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiEmittedInvoiceEmittedInvoice extends Struct.CollectionTypeSchema {
  collectionName: 'emitted_invoices';
  info: {
    displayName: 'Emitted Invoices';
    pluralName: 'emitted-invoices';
    singularName: 'emitted-invoice';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_info: Schema.Attribute.Component<'contact.contact-data', false>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deductible_vat_pct: Schema.Attribute.Decimal;
    document_concept: Schema.Attribute.String;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    estimated_payment: Schema.Attribute.Date;
    face: Schema.Attribute.Boolean;
    lines: Schema.Attribute.Component<'invoice-line.invoice-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::emitted-invoice.emitted-invoice'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    pdf: Schema.Attribute.String;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    qr: Schema.Attribute.Text;
    rectification_method_code: Schema.Attribute.String & Schema.Attribute.DefaultTo<'01'>;
    rectification_reason: Schema.Attribute.Text;
    rectification_reason_code: Schema.Attribute.String;
    rectified_invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    state: Schema.Attribute.Enumeration<['draft', 'real']>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    user_draft: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    user_last: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    user_real: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    vat_paid_date: Schema.Attribute.DateTime;
    verifactu: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
  };
}

export interface ApiEstimatedHourEstimatedHour extends Struct.CollectionTypeSchema {
  collectionName: 'estimated_hours';
  info: {
    displayName: 'EstimatedHours';
    pluralName: 'estimated-hours';
    singularName: 'estimated-hour';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    comment: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    from: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::estimated-hour.estimated-hour'> &
      Schema.Attribute.Private;
    monthly_quantity: Schema.Attribute.Decimal;
    phase_income: Schema.Attribute.Relation<'manyToOne', 'api::phase-income.phase-income'>;
    publishedAt: Schema.Attribute.DateTime;
    quantity: Schema.Attribute.Decimal;
    quantity_type: Schema.Attribute.Enumeration<['total', 'week', 'month']>;
    to: Schema.Attribute.Date;
    total_amount: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiExpenseTypeExpenseType extends Struct.CollectionTypeSchema {
  collectionName: 'expense_types';
  info: {
    displayName: 'Expense Types';
    pluralName: 'expense-types';
    singularName: 'expense-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::expense-type.expense-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_pct: Schema.Attribute.Decimal;
  };
}

export interface ApiFaceQueueFaceQueue extends Struct.CollectionTypeSchema {
  collectionName: 'face_queues';
  info: {
    displayName: 'Face Queue';
    pluralName: 'face-queues';
    singularName: 'face-queue';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    attempts: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    emitted_invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    invoice: Schema.Attribute.JSON;
    last_status_check: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::face-queue.face-queue'> &
      Schema.Attribute.Private;
    mode: Schema.Attribute.Enumeration<['test', 'real']>;
    publishedAt: Schema.Attribute.DateTime;
    registration_number: Schema.Attribute.String;
    request_body: Schema.Attribute.Text;
    request_url: Schema.Attribute.String;
    response_body: Schema.Attribute.Text;
    response_code: Schema.Attribute.Integer;
    status: Schema.Attribute.Enumeration<['pending', 'registered', 'delivered', 'rejected', 'error']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiFestiveTypeFestiveType extends Struct.CollectionTypeSchema {
  collectionName: 'festive_types';
  info: {
    displayName: 'Festive Type';
    pluralName: 'festive-types';
    singularName: 'festive-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::festive-type.festive-type'> &
      Schema.Attribute.Private;
    max: Schema.Attribute.Integer;
    name: Schema.Attribute.String;
    personal: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiFestiveFestive extends Struct.CollectionTypeSchema {
  collectionName: 'festives';
  info: {
    displayName: 'Festives';
    pluralName: 'festives';
    singularName: 'festive';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    festive_type: Schema.Attribute.Relation<'oneToOne', 'api::festive-type.festive-type'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::festive.festive'> & Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiFormSubmissionFormSubmission extends Struct.CollectionTypeSchema {
  collectionName: 'form_submissions';
  info: {
    displayName: 'FormSubmission';
    pluralName: 'form-submissions';
    singularName: 'form-submission';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    email: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::form-submission.form-submission'> &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiHomeMenuHomeMenu extends Struct.SingleTypeSchema {
  collectionName: 'home_menus';
  info: {
    displayName: 'HomeMenu';
    pluralName: 'home-menu-setting';
    singularName: 'home-menu';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    homegroup: Schema.Attribute.Component<'homegroup.homegroup', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::home-menu.home-menu'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiIncidenceIncidence extends Struct.CollectionTypeSchema {
  collectionName: 'incidences';
  info: {
    displayName: 'Incidences';
    pluralName: 'incidences';
    singularName: 'incidence';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    closed_date: Schema.Attribute.DateTime;
    closed_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    created_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    incidence_response: Schema.Attribute.Component<'orders.incidence-response', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::incidence.incidence'> &
      Schema.Attribute.Private;
    order: Schema.Attribute.Relation<'manyToOne', 'api::order.order'>;
    publishedAt: Schema.Attribute.DateTime;
    state: Schema.Attribute.Enumeration<['open', 'wip', 'closed']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiIncomeTypeIncomeType extends Struct.CollectionTypeSchema {
  collectionName: 'income_types';
  info: {
    displayName: 'Income Types';
    pluralName: 'income-types';
    singularName: 'income-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::income-type.income-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    trashed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_pct: Schema.Attribute.Decimal;
  };
}

export interface ApiJustificationJustification extends Struct.CollectionTypeSchema {
  collectionName: 'justifications';
  info: {
    displayName: 'Justifications';
    pluralName: 'justifications';
    singularName: 'justification';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    emitted_invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    hours: Schema.Attribute.Decimal;
    justification_type: Schema.Attribute.Enumeration<['real', 'estimated']> &
      Schema.Attribute.DefaultTo<'real'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::justification.justification'> &
      Schema.Attribute.Private;
    month: Schema.Attribute.Integer;
    project: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    quantity: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    year: Schema.Attribute.Integer;
  };
}

export interface ApiKanbanViewKanbanView extends Struct.CollectionTypeSchema {
  collectionName: 'kanban_views';
  info: {
    displayName: 'Kanban View';
    pluralName: 'kanban-views';
    singularName: 'kanban-view';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    cardViewJSON: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::kanban-view.kanban-view'> &
      Schema.Attribute.Private;
    projectId: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    userId: Schema.Attribute.Integer;
    view: Schema.Attribute.String;
  };
}

export interface ApiLegalFormLegalForm extends Struct.CollectionTypeSchema {
  collectionName: 'legal_forms';
  info: {
    displayName: 'Legal Forms';
    pluralName: 'legal-forms';
    singularName: 'legal-form';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::legal-form.legal-form'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiLogoLogo extends Struct.CollectionTypeSchema {
  collectionName: 'logos';
  info: {
    displayName: 'Logos';
    pluralName: 'logos';
    singularName: 'logo';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::logo.logo'> & Schema.Attribute.Private;
    logo: Schema.Attribute.Media<'images'>;
    order: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<10>;
    publishedAt: Schema.Attribute.DateTime;
    trashed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    url: Schema.Attribute.String;
  };
}

export interface ApiMeMe extends Struct.SingleTypeSchema {
  collectionName: 'us';
  info: {
    displayName: 'me';
    pluralName: 'me-setting';
    singularName: 'me';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    address: Schema.Attribute.String;
    bank_account_default: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    bank_account_irpf: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    bank_account_payroll: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    bank_account_ss: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    bank_account_vat: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    ccc: Schema.Attribute.String;
    certificate_pwd: Schema.Attribute.String & Schema.Attribute.Private;
    city: Schema.Attribute.String;
    contact_form_email: Schema.Attribute.String;
    contact_form_text: Schema.Attribute.RichText;
    contact_form_thankyou: Schema.Attribute.RichText;
    country: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    dir3_api_token: Schema.Attribute.String & Schema.Attribute.Private;
    dir3_api_url: Schema.Attribute.String;
    email: Schema.Attribute.Email;
    face: Schema.Attribute.Enumeration<['no', 'test', 'real']>;
    face_certificate: Schema.Attribute.Media<'files'>;
    face_certificate_password: Schema.Attribute.String & Schema.Attribute.Private;
    face_invoice_format: Schema.Attribute.Enumeration<['ubl', 'facturae']> &
      Schema.Attribute.DefaultTo<'facturae'>;
    face_real_endpoint: Schema.Attribute.String;
    face_test_endpoint: Schema.Attribute.String;
    front_url: Schema.Attribute.String;
    google_credentials: Schema.Attribute.Media<'files'>;
    ical: Schema.Attribute.String;
    invoice_email: Schema.Attribute.String;
    invoice_footer: Schema.Attribute.Text;
    invoice_parser_api_token: Schema.Attribute.String & Schema.Attribute.Private;
    invoice_parser_api_url: Schema.Attribute.String;
    invoice_subject: Schema.Attribute.String;
    invoice_template: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::me.me'> & Schema.Attribute.Private;
    logo: Schema.Attribute.Media<'images'>;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    nif: Schema.Attribute.String;
    options: Schema.Attribute.Component<'options.options', false>;
    order_footer: Schema.Attribute.Text;
    orders_options: Schema.Attribute.Component<'options.orders-options', false>;
    pdf_invoice_parser: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    phone: Schema.Attribute.String;
    postcode: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    quote_footer: Schema.Attribute.Text;
    quotes: Schema.Attribute.Component<'options.quotes', false>;
    state: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    verifactu: Schema.Attribute.Enumeration<['no', 'test', 'real']>;
  };
}

export interface ApiMonthMonth extends Struct.CollectionTypeSchema {
  collectionName: 'months';
  info: {
    displayName: 'Months';
    pluralName: 'months';
    singularName: 'month';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::month.month'> & Schema.Attribute.Private;
    month: Schema.Attribute.Integer;
    month_number: Schema.Attribute.String;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiOrderOrder extends Struct.CollectionTypeSchema {
  collectionName: 'orders';
  info: {
    displayName: 'Orders';
    pluralName: 'orders';
    singularName: 'order';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    collection_order: Schema.Attribute.Relation<'manyToOne', 'api::order.order'>;
    collection_orders: Schema.Attribute.Relation<'oneToMany', 'api::order.order'>;
    collection_pickup_date: Schema.Attribute.Date;
    collection_pickup_route: Schema.Attribute.Relation<'oneToOne', 'api::route.route'>;
    collection_point: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    comments: Schema.Attribute.Text;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_address: Schema.Attribute.String;
    contact_city: Schema.Attribute.String;
    contact_legal_form: Schema.Attribute.Relation<'oneToOne', 'api::legal-form.legal-form'>;
    contact_name: Schema.Attribute.String;
    contact_nif: Schema.Attribute.String;
    contact_notes: Schema.Attribute.Text;
    contact_phone: Schema.Attribute.String;
    contact_pickup_discount: Schema.Attribute.Decimal;
    contact_postcode: Schema.Attribute.String;
    contact_time_slot_1_end: Schema.Attribute.Decimal;
    contact_time_slot_1_ini: Schema.Attribute.Decimal;
    contact_time_slot_2_end: Schema.Attribute.Decimal;
    contact_time_slot_2_ini: Schema.Attribute.Decimal;
    contact_trade_name: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    delivery_date: Schema.Attribute.Date;
    delivery_type: Schema.Attribute.Relation<'oneToOne', 'api::delivery-type.delivery-type'>;
    deposit_date: Schema.Attribute.DateTime;
    deposit_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    emitted_invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    emitted_invoice_datetime: Schema.Attribute.DateTime;
    estimated_delivery_date: Schema.Attribute.Date;
    fragile: Schema.Attribute.Boolean;
    incidences: Schema.Attribute.Relation<'oneToMany', 'api::incidence.incidence'>;
    is_collection_order: Schema.Attribute.Boolean;
    kilograms: Schema.Attribute.Decimal;
    last_mile: Schema.Attribute.Boolean;
    lines: Schema.Attribute.Component<'orders.lines', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::order.order'> & Schema.Attribute.Private;
    multidelivery_discount: Schema.Attribute.Decimal;
    owner: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    picked_up: Schema.Attribute.Boolean;
    pickup: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    pickup_date: Schema.Attribute.DateTime;
    pickup_point: Schema.Attribute.Boolean;
    pickup_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    price: Schema.Attribute.Decimal;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
    provider_order_number: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    refrigerated: Schema.Attribute.Boolean;
    route: Schema.Attribute.Relation<'oneToOne', 'api::route.route'>;
    route_date: Schema.Attribute.Date;
    route_rate: Schema.Attribute.Relation<'oneToOne', 'api::route-rate.route-rate'>;
    status: Schema.Attribute.Enumeration<
      ['pending', 'deposited', 'processed', 'delivered', 'invoiced', 'cancelled', 'distributing', 'lastmile']
    >;
    transfer: Schema.Attribute.Boolean;
    transfer_end_date: Schema.Attribute.DateTime;
    transfer_end_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    transfer_pickup_destination: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    transfer_pickup_origin: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    transfer_route: Schema.Attribute.Relation<'oneToOne', 'api::route.route'>;
    transfer_route_date: Schema.Attribute.Date;
    transfer_start_date: Schema.Attribute.DateTime;
    transfer_start_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    units: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    volume_discount: Schema.Attribute.Decimal;
  };
}

export interface ApiOrdersImportOrdersImport extends Struct.CollectionTypeSchema {
  collectionName: 'orders_imports';
  info: {
    displayName: 'OrdersImports';
    pluralName: 'orders-imports';
    singularName: 'orders-import';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    file: Schema.Attribute.Media<'files'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::orders-import.orders-import'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiOrdersTrackingOrdersTracking extends Struct.CollectionTypeSchema {
  collectionName: 'orders_trackings';
  info: {
    displayName: 'OrdersTracking';
    pluralName: 'orders-trackings';
    singularName: 'orders-tracking';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    admin_user: Schema.Attribute.Relation<'oneToOne', 'admin::user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::orders-tracking.orders-tracking'> &
      Schema.Attribute.Private;
    order_id: Schema.Attribute.Integer;
    order_status: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiPaymentMethodPaymentMethod extends Struct.CollectionTypeSchema {
  collectionName: 'payment_methods';
  info: {
    displayName: 'Payment Methods';
    pluralName: 'payment-methods';
    singularName: 'payment-method';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    default: Schema.Attribute.Boolean;
    description: Schema.Attribute.RichText;
    invoice_text: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::payment-method.payment-method'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    nameTreasury: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiPayrollPayroll extends Struct.CollectionTypeSchema {
  collectionName: 'payrolls';
  info: {
    displayName: 'Payroll';
    pluralName: 'payrolls';
    singularName: 'payroll';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    emitted: Schema.Attribute.Date;
    irpf_base: Schema.Attribute.Decimal;
    irpf_date: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::payroll.payroll'> & Schema.Attribute.Private;
    month: Schema.Attribute.Relation<'oneToOne', 'api::month.month'>;
    net_base: Schema.Attribute.Decimal;
    net_date: Schema.Attribute.Date;
    other_base: Schema.Attribute.Decimal;
    other_date: Schema.Attribute.Date;
    paid: Schema.Attribute.Boolean;
    paid_date: Schema.Attribute.Date;
    publishedAt: Schema.Attribute.DateTime;
    ss_base: Schema.Attribute.Decimal;
    ss_date: Schema.Attribute.Date;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    year: Schema.Attribute.Relation<'oneToOne', 'api::year.year'>;
  };
}

export interface ApiPhaseExpensePhaseExpense extends Struct.CollectionTypeSchema {
  collectionName: 'phase_expenses';
  info: {
    displayName: 'PhaseExpense';
    pluralName: 'phase-expenses';
    singularName: 'phase-expense';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    concept: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    expense: Schema.Attribute.Relation<'oneToOne', 'api::received-expense.received-expense'>;
    expense_type: Schema.Attribute.Relation<'oneToOne', 'api::expense-type.expense-type'>;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::received-invoice.received-invoice'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::phase-expense.phase-expense'> &
      Schema.Attribute.Private;
    paid: Schema.Attribute.Boolean;
    project_original_phase: Schema.Attribute.Relation<
      'manyToOne',
      'api::project-original-phase.project-original-phase'
    >;
    project_phase: Schema.Attribute.Relation<'manyToOne', 'api::project-phase.project-phase'>;
    provider: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    publishedAt: Schema.Attribute.DateTime;
    quantity: Schema.Attribute.Decimal;
    total_amount: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_pct: Schema.Attribute.Integer;
    warning: Schema.Attribute.Boolean;
  };
}

export interface ApiPhaseIncomePhaseIncome extends Struct.CollectionTypeSchema {
  collectionName: 'phase_incomes';
  info: {
    displayName: 'PhaseIncome';
    pluralName: 'phase-incomes';
    singularName: 'phase-income';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    client: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    concept: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    estimated_hours: Schema.Attribute.Relation<'oneToMany', 'api::estimated-hour.estimated-hour'>;
    income: Schema.Attribute.Relation<'oneToOne', 'api::received-income.received-income'>;
    income_type: Schema.Attribute.Relation<'oneToOne', 'api::income-type.income-type'>;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::phase-income.phase-income'> &
      Schema.Attribute.Private;
    paid: Schema.Attribute.Boolean;
    project_original_phase: Schema.Attribute.Relation<
      'manyToOne',
      'api::project-original-phase.project-original-phase'
    >;
    project_phase: Schema.Attribute.Relation<'manyToOne', 'api::project-phase.project-phase'>;
    publishedAt: Schema.Attribute.DateTime;
    quantity: Schema.Attribute.Decimal;
    total_amount: Schema.Attribute.Decimal;
    total_estimated_hours: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_pct: Schema.Attribute.Integer;
    warning: Schema.Attribute.Boolean;
  };
}

export interface ApiPickupPickup extends Struct.CollectionTypeSchema {
  collectionName: 'pickups';
  info: {
    displayName: 'Pickups';
    pluralName: 'pickups';
    singularName: 'pickup';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    alias: Schema.Attribute.String;
    allowed_users: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.user'>;
    city: Schema.Attribute.Relation<'oneToOne', 'api::city.city'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::pickup.pickup'> & Schema.Attribute.Private;
    message: Schema.Attribute.Text;
    name: Schema.Attribute.String;
    pickup: Schema.Attribute.Boolean;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiPivotTableViewPivotTableView extends Struct.CollectionTypeSchema {
  collectionName: 'pivot_table_views';
  info: {
    displayName: 'PivotTableView';
    pluralName: 'pivot-table-views';
    singularName: 'pivot-table-view';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    config: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    identifier: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::pivot-table-view.pivot-table-view'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProductProduct extends Struct.CollectionTypeSchema {
  collectionName: 'products';
  info: {
    displayName: 'Product';
    pluralName: 'products';
    singularName: 'product';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    base: Schema.Attribute.Decimal;
    code: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::product.product'> & Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    trashed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat: Schema.Attribute.Decimal;
  };
}

export interface ApiProjectDocumentProjectDocument extends Struct.CollectionTypeSchema {
  collectionName: 'project_documents';
  info: {
    displayName: 'Project Documents';
    pluralName: 'project-documents';
    singularName: 'project-document';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    expenseId: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-document.project-document'> &
      Schema.Attribute.Private;
    phaseId: Schema.Attribute.Integer;
    project: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    received_expense: Schema.Attribute.Relation<'oneToOne', 'api::received-expense.received-expense'>;
    received_invoice: Schema.Attribute.Relation<'oneToOne', 'api::received-invoice.received-invoice'>;
    subphaseId: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectLikelihoodProjectLikelihood extends Struct.CollectionTypeSchema {
  collectionName: 'project_likelihoods';
  info: {
    displayName: 'project_likelihood';
    pluralName: 'project-likelihoods';
    singularName: 'project-likelihood';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-likelihood.project-likelihood'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectOriginalPhaseProjectOriginalPhase extends Struct.CollectionTypeSchema {
  collectionName: 'project_original_phases';
  info: {
    displayName: 'ProjectOriginalPhases';
    pluralName: 'project-original-phases';
    singularName: 'project-original-phase';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    expenses: Schema.Attribute.Relation<'oneToMany', 'api::phase-expense.phase-expense'>;
    incomes: Schema.Attribute.Relation<'oneToMany', 'api::phase-income.phase-income'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::project-original-phase.project-original-phase'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectPhaseProjectPhase extends Struct.CollectionTypeSchema {
  collectionName: 'project_phases';
  info: {
    displayName: 'ProjectPhases';
    pluralName: 'project-phases';
    singularName: 'project-phase';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    expenses: Schema.Attribute.Relation<'oneToMany', 'api::phase-expense.phase-expense'>;
    incomes: Schema.Attribute.Relation<'oneToMany', 'api::phase-income.phase-income'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-phase.project-phase'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectScopeProjectScope extends Struct.CollectionTypeSchema {
  collectionName: 'project_scopes';
  info: {
    displayName: 'Scopes';
    pluralName: 'project-scopes';
    singularName: 'project-scope';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    disabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    group: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-scope.project-scope'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    short_name: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectStateProjectState extends Struct.CollectionTypeSchema {
  collectionName: 'project_states';
  info: {
    displayName: 'Project States';
    pluralName: 'project-states';
    singularName: 'project-state';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    can_assign_activities: Schema.Attribute.Boolean;
    can_assign_documents: Schema.Attribute.Boolean;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-state.project-state'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectTypeProjectType extends Struct.CollectionTypeSchema {
  collectionName: 'project_types';
  info: {
    displayName: 'Project Types';
    pluralName: 'project-types';
    singularName: 'project-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project-type.project-type'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiProjectProject extends Struct.CollectionTypeSchema {
  collectionName: 'projects';
  info: {
    displayName: 'Projects';
    pluralName: 'projects';
    singularName: 'project';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    activities: Schema.Attribute.Relation<'oneToMany', 'api::activity.activity'>;
    activity_types: Schema.Attribute.Relation<'oneToMany', 'api::activity-type.activity-type'>;
    balance: Schema.Attribute.Decimal;
    clients: Schema.Attribute.Relation<'manyToMany', 'api::contact.contact'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    creation_step: Schema.Attribute.Enumeration<
      ['basic_data', 'phases_budget', 'planning', 'confirmation', 'completed']
    >;
    date_end: Schema.Attribute.Date;
    date_start: Schema.Attribute.Date;
    default_dedication_type: Schema.Attribute.Relation<'oneToOne', 'api::dedication-type.dedication-type'>;
    description: Schema.Attribute.RichText;
    diets: Schema.Attribute.Relation<'oneToMany', 'api::diet.diet'>;
    dirty: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted_grants: Schema.Attribute.Relation<'oneToMany', 'api::emitted-grant.emitted-grant'>;
    emitted_invoices: Schema.Attribute.Relation<'oneToMany', 'api::emitted-invoice.emitted-invoice'>;
    estimated_balance: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0>;
    estimated_incomes_expenses: Schema.Attribute.Decimal;
    global_activity_types: Schema.Attribute.Relation<'manyToMany', 'api::activity-type.activity-type'>;
    grantable: Schema.Attribute.Boolean;
    grantable_amount: Schema.Attribute.Decimal;
    grantable_amount_total: Schema.Attribute.Decimal;
    grantable_cofinancing: Schema.Attribute.Decimal;
    grantable_cofinancing_pct: Schema.Attribute.Decimal;
    grantable_contacts: Schema.Attribute.Component<'grantable-contact.grantable-contact', true>;
    grantable_date: Schema.Attribute.Date;
    grantable_estructural_pct: Schema.Attribute.Decimal;
    grantable_intercooperation: Schema.Attribute.Boolean;
    grantable_leader: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    grantable_reference: Schema.Attribute.String;
    grantable_structural_expenses: Schema.Attribute.Decimal;
    grantable_structural_expenses_justify_invoices: Schema.Attribute.Decimal;
    grantable_years: Schema.Attribute.Component<'grantable.grantable-year', true>;
    incomes_expenses: Schema.Attribute.Decimal;
    intercooperations: Schema.Attribute.Relation<'manyToMany', 'api::contact.contact'>;
    internal_notes: Schema.Attribute.Text;
    invoice_hours_price: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0>;
    is_mother: Schema.Attribute.Boolean;
    justification_date: Schema.Attribute.Date;
    leader: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    linked_emitted_invoices: Schema.Attribute.Relation<'manyToMany', 'api::emitted-invoice.emitted-invoice'>;
    linked_received_expenses: Schema.Attribute.Relation<
      'manyToMany',
      'api::received-expense.received-expense'
    >;
    linked_received_incomes: Schema.Attribute.Relation<'manyToMany', 'api::received-income.received-income'>;
    linked_received_invoices: Schema.Attribute.Relation<
      'manyToMany',
      'api::received-invoice.received-invoice'
    >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::project.project'> & Schema.Attribute.Private;
    mother: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    name: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Unique;
    original_incomes_expenses: Schema.Attribute.Decimal;
    periodification: Schema.Attribute.Component<'periodification.periodification', true>;
    project_likelihood: Schema.Attribute.Relation<'oneToOne', 'api::project-likelihood.project-likelihood'>;
    project_original_phases: Schema.Attribute.Relation<
      'oneToMany',
      'api::project-original-phase.project-original-phase'
    >;
    project_phases: Schema.Attribute.Relation<'oneToMany', 'api::project-phase.project-phase'>;
    project_scope: Schema.Attribute.Relation<'oneToOne', 'api::project-scope.project-scope'>;
    project_state: Schema.Attribute.Relation<'oneToOne', 'api::project-state.project-state'>;
    project_type: Schema.Attribute.Relation<'oneToOne', 'api::project-type.project-type'>;
    publishedAt: Schema.Attribute.DateTime;
    purpose: Schema.Attribute.RichText;
    quotes: Schema.Attribute.Relation<'oneToMany', 'api::quote.quote'>;
    received_expenses: Schema.Attribute.Relation<'oneToMany', 'api::received-expense.received-expense'>;
    received_grants: Schema.Attribute.Relation<'oneToMany', 'api::received-grant.received-grant'>;
    received_incomes: Schema.Attribute.Relation<'oneToMany', 'api::received-income.received-income'>;
    received_invoices: Schema.Attribute.Relation<'oneToMany', 'api::received-invoice.received-invoice'>;
    region: Schema.Attribute.Relation<'oneToOne', 'api::region.region'>;
    strategies: Schema.Attribute.Relation<'manyToMany', 'api::strategy.strategy'>;
    structural_expenses: Schema.Attribute.Boolean;
    structural_expenses_pct: Schema.Attribute.Decimal;
    tickets: Schema.Attribute.Relation<'oneToMany', 'api::ticket.ticket'>;
    total_estimated_expenses: Schema.Attribute.Decimal;
    total_estimated_expenses_vat: Schema.Attribute.Decimal;
    total_estimated_hours: Schema.Attribute.Decimal;
    total_estimated_hours_price: Schema.Attribute.Decimal;
    total_estimated_incomes: Schema.Attribute.Decimal;
    total_expenses: Schema.Attribute.Decimal;
    total_expenses_hours: Schema.Attribute.Decimal;
    total_expenses_vat: Schema.Attribute.Decimal;
    total_incomes: Schema.Attribute.Decimal;
    total_original_expenses: Schema.Attribute.Decimal;
    total_original_expenses_vat: Schema.Attribute.Decimal;
    total_original_hours: Schema.Attribute.Decimal;
    total_original_hours_price: Schema.Attribute.Decimal;
    total_original_incomes: Schema.Attribute.Decimal;
    total_real_expenses: Schema.Attribute.Decimal;
    total_real_expenses_vat: Schema.Attribute.Decimal;
    total_real_hours: Schema.Attribute.Decimal;
    total_real_hours_price: Schema.Attribute.Decimal;
    total_real_incomes: Schema.Attribute.Decimal;
    total_real_incomes_expenses: Schema.Attribute.Decimal;
    trashed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    treasury_annotations: Schema.Attribute.Relation<'oneToMany', 'api::treasury.treasury'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiQuoteQuote extends Struct.CollectionTypeSchema {
  collectionName: 'quotes';
  info: {
    displayName: 'Quotes';
    pluralName: 'quotes';
    singularName: 'quote';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    accepted: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    accepted_date: Schema.Attribute.Date;
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_info: Schema.Attribute.Component<'contact.contact-data', false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    document_concept: Schema.Attribute.String;
    emitted: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.invoice-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::quote.quote'> & Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    pdf: Schema.Attribute.String;
    proforma: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiReceivedExpenseReceivedExpense extends Struct.CollectionTypeSchema {
  collectionName: 'received_expenses';
  info: {
    displayName: 'Received Expenses';
    pluralName: 'received-expenses';
    singularName: 'received-expense';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_info: Schema.Attribute.Component<'contact.contact-data', false>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deductible_vat_pct: Schema.Attribute.Decimal;
    document_concept: Schema.Attribute.String;
    document_type: Schema.Attribute.Relation<'oneToOne', 'api::document-type.document-type'>;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.ticket-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::received-expense.received-expense'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_paid_date: Schema.Attribute.DateTime;
  };
}

export interface ApiReceivedGrantReceivedGrant extends Struct.CollectionTypeSchema {
  collectionName: 'received_grants';
  info: {
    displayName: 'Received Grants';
    pluralName: 'received-grants';
    singularName: 'received-grant';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_grant_number: Schema.Attribute.String;
    convocatory: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    department: Schema.Attribute.String;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::received-grant.received-grant'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiReceivedIncomeReceivedIncome extends Struct.CollectionTypeSchema {
  collectionName: 'received_incomes';
  info: {
    displayName: 'Received Incomes';
    pluralName: 'received-incomes';
    singularName: 'received-income';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_info: Schema.Attribute.Component<'contact.contact-data', false>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deductible_vat_pct: Schema.Attribute.Decimal;
    document_concept: Schema.Attribute.String;
    document_type: Schema.Attribute.Relation<'oneToOne', 'api::document-type.document-type'>;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    estimated_payment: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.ticket-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::received-income.received-income'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_paid_date: Schema.Attribute.DateTime;
  };
}

export interface ApiReceivedInvoiceReceivedInvoice extends Struct.CollectionTypeSchema {
  collectionName: 'received_invoices';
  info: {
    displayName: 'Received Invoices';
    pluralName: 'received-invoices';
    singularName: 'received-invoice';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    comments_internal: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_info: Schema.Attribute.Component<'contact.contact-data', false>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deductible_vat_pct: Schema.Attribute.Decimal;
    document_concept: Schema.Attribute.String;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.invoice-line-expenses', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::received-invoice.received-invoice'> &
      Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    vat_paid_date: Schema.Attribute.DateTime;
  };
}

export interface ApiRegionRegion extends Struct.CollectionTypeSchema {
  collectionName: 'regions';
  info: {
    displayName: 'Regions';
    pluralName: 'regions';
    singularName: 'region';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::region.region'> & Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiRouteFestiveRouteFestive extends Struct.CollectionTypeSchema {
  collectionName: 'route_festives';
  info: {
    displayName: 'RouteFestive';
    pluralName: 'route-festives';
    singularName: 'route-festive';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::route-festive.route-festive'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    route: Schema.Attribute.Relation<'oneToOne', 'api::route.route'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiRouteRateRouteRate extends Struct.CollectionTypeSchema {
  collectionName: 'route_rates';
  info: {
    displayName: 'RouteRate';
    pluralName: 'route-rates';
    singularName: 'route-rate';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    additional30: Schema.Attribute.Decimal;
    additional60: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    delivery_type: Schema.Attribute.Relation<'oneToOne', 'api::delivery-type.delivery-type'>;
    from10to20: Schema.Attribute.Decimal;
    from20to30: Schema.Attribute.Decimal;
    from30to40: Schema.Attribute.Decimal;
    from40to50: Schema.Attribute.Decimal;
    from50to60: Schema.Attribute.Decimal;
    less10: Schema.Attribute.Decimal;
    less15: Schema.Attribute.Decimal;
    less30: Schema.Attribute.Decimal;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::route-rate.route-rate'> &
      Schema.Attribute.Private;
    more10: Schema.Attribute.Decimal;
    name: Schema.Attribute.String;
    pickup: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    pickup_point: Schema.Attribute.Decimal;
    publishedAt: Schema.Attribute.DateTime;
    ratev2: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    routes: Schema.Attribute.Relation<'manyToMany', 'api::route.route'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiRouteRoute extends Struct.CollectionTypeSchema {
  collectionName: 'routes';
  info: {
    displayName: 'Route';
    pluralName: 'routes';
    singularName: 'route';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    active: Schema.Attribute.Boolean;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    delivery_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    friday: Schema.Attribute.Boolean;
    is_transfer_route: Schema.Attribute.Boolean;
    is_transfer_route_date: Schema.Attribute.Enumeration<['only_same_day', 'only_previous_days']>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::route.route'> & Schema.Attribute.Private;
    monday: Schema.Attribute.Boolean;
    name: Schema.Attribute.String;
    order: Schema.Attribute.Integer;
    pickup: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    project: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    route_rates: Schema.Attribute.Relation<'manyToMany', 'api::route-rate.route-rate'>;
    saturday: Schema.Attribute.Boolean;
    short_name: Schema.Attribute.String;
    sunday: Schema.Attribute.Boolean;
    thursday: Schema.Attribute.Boolean;
    transfer_pickup: Schema.Attribute.Relation<'oneToOne', 'api::pickup.pickup'>;
    tuesday: Schema.Attribute.Boolean;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    volume_discount_number_of_orders: Schema.Attribute.Integer;
    volume_discount_price: Schema.Attribute.Decimal;
    wednesday: Schema.Attribute.Boolean;
  };
}

export interface ApiSectorSector extends Struct.CollectionTypeSchema {
  collectionName: 'sectors';
  info: {
    displayName: 'Sectors';
    pluralName: 'sectors';
    singularName: 'sector';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::sector.sector'> & Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiSerieSerie extends Struct.CollectionTypeSchema {
  collectionName: 'serials';
  info: {
    displayName: 'Serials';
    pluralName: 'series';
    singularName: 'serie';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    emitted_invoice_number: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    leadingZeros: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::serie.serie'> & Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    rectificative: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiSocialEntitySocialEntity extends Struct.CollectionTypeSchema {
  collectionName: 'social_entities';
  info: {
    displayName: 'Social Entity';
    pluralName: 'social-entities';
    singularName: 'social-entity';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::social-entity.social-entity'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiStartupScriptStartupScript extends Struct.CollectionTypeSchema {
  collectionName: 'startup_scripts';
  info: {
    displayName: 'Startup Scripts';
    pluralName: 'startup-scripts';
    singularName: 'startup-script';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    end: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::startup-script.startup-script'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    start: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiStrategyStrategy extends Struct.CollectionTypeSchema {
  collectionName: 'strategies';
  info: {
    displayName: 'Strategies';
    pluralName: 'strategies';
    singularName: 'strategy';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Unique;
    code_name: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.RichText;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::strategy.strategy'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    projects: Schema.Attribute.Relation<'manyToMany', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiTaskStateTaskState extends Struct.CollectionTypeSchema {
  collectionName: 'task_states';
  info: {
    displayName: 'Task State';
    pluralName: 'task-states';
    singularName: 'task-state';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::task-state.task-state'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    order: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiTaskTask extends Struct.CollectionTypeSchema {
  collectionName: 'tasks';
  info: {
    displayName: 'Task';
    pluralName: 'tasks';
    singularName: 'task';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    activity_type: Schema.Attribute.Relation<'oneToOne', 'api::activity-type.activity-type'>;
    archived: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    checklist: Schema.Attribute.Component<'task.task-checklist', true>;
    created: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.RichText;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    due_date: Schema.Attribute.Date;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::task.task'> & Schema.Attribute.Private;
    name: Schema.Attribute.String;
    project: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    task_state: Schema.Attribute.Relation<'oneToOne', 'api::task-state.task-state'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_users: Schema.Attribute.Relation<'manyToMany', 'plugin::users-permissions.user'>;
  };
}

export interface ApiTicketTicket extends Struct.CollectionTypeSchema {
  collectionName: 'tickets';
  info: {
    displayName: 'Tickets';
    pluralName: 'tickets';
    singularName: 'ticket';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    code: Schema.Attribute.String;
    comments: Schema.Attribute.RichText;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contact.contact'>;
    contact_invoice_number: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    documents: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    emitted: Schema.Attribute.Date;
    lines: Schema.Attribute.Component<'invoice-line.ticket-line', true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::ticket.ticket'> & Schema.Attribute.Private;
    number: Schema.Attribute.Integer;
    paid: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paid_date: Schema.Attribute.Date;
    paybefore: Schema.Attribute.Date;
    payment_method: Schema.Attribute.Relation<'oneToOne', 'api::payment-method.payment-method'>;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    sent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    sent_date: Schema.Attribute.Date;
    serial: Schema.Attribute.Relation<'oneToOne', 'api::serie.serie'>;
    total: Schema.Attribute.Decimal;
    total_base: Schema.Attribute.Decimal;
    total_irpf: Schema.Attribute.Decimal;
    total_vat: Schema.Attribute.Decimal;
    updatable: Schema.Attribute.Boolean;
    updatable_admin: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiTimeCounterTimeCounter extends Struct.CollectionTypeSchema {
  collectionName: 'time_counters';
  info: {
    displayName: 'Time Counter';
    pluralName: 'time-counters';
    singularName: 'time-counter';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::time-counter.time-counter'> &
      Schema.Attribute.Private;
    project: Schema.Attribute.Relation<'oneToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    start: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiTreasuryValidationTreasuryValidation extends Struct.CollectionTypeSchema {
  collectionName: 'treasury_validations';
  info: {
    description: 'Track validated treasury movements';
    displayName: 'Treasury Validation';
    pluralName: 'treasury-validations';
    singularName: 'treasury-validation';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    entity_id: Schema.Attribute.Integer & Schema.Attribute.Required;
    entity_type: Schema.Attribute.Enumeration<
      [
        'emitted-invoices',
        'received-invoices',
        'received-incomes',
        'received-expenses',
        'payrolls',
        'treasuries',
      ]
    > &
      Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::treasury-validation.treasury-validation'> &
      Schema.Attribute.Private;
    notes: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    sub_type: Schema.Attribute.Enumeration<['irpf', 'ss', 'other']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    validated_by: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiTreasuryTreasury extends Struct.CollectionTypeSchema {
  collectionName: 'treasuries';
  info: {
    displayName: 'Treasury Annotations';
    pluralName: 'treasuries';
    singularName: 'treasury';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    balance: Schema.Attribute.Decimal;
    bank_account: Schema.Attribute.Relation<'oneToOne', 'api::bank-account.bank-account'>;
    comment: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    is_real_balance: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::treasury.treasury'> &
      Schema.Attribute.Private;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    total: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiUserFestiveUserFestive extends Struct.CollectionTypeSchema {
  collectionName: 'user_festives';
  info: {
    displayName: 'User Festive';
    pluralName: 'user-festives';
    singularName: 'user-festive';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    festive_type: Schema.Attribute.Relation<'oneToOne', 'api::festive-type.festive-type'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::user-festive.user-festive'> &
      Schema.Attribute.Private;
    max: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    year: Schema.Attribute.Relation<'oneToOne', 'api::year.year'>;
  };
}

export interface ApiVatTypeVatType extends Struct.CollectionTypeSchema {
  collectionName: 'vat_types';
  info: {
    displayName: 'VatType';
    pluralName: 'vat-types';
    singularName: 'vat-type';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::vat-type.vat-type'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    value: Schema.Attribute.Integer;
  };
}

export interface ApiVerifactuChainVerifactuChain extends Struct.CollectionTypeSchema {
  collectionName: 'verifactu_chains';
  info: {
    displayName: 'Verifactu Chain';
    pluralName: 'verifactu-chains';
    singularName: 'verifactu-chain';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    actions: Schema.Attribute.Enumeration<['none', 'replacement']>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    emitted_invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    hash: Schema.Attribute.String;
    invoice_json: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::verifactu-chain.verifactu-chain'> &
      Schema.Attribute.Private;
    mode: Schema.Attribute.Enumeration<['test', 'real']>;
    publishedAt: Schema.Attribute.DateTime;
    qr: Schema.Attribute.Text;
    request_url: Schema.Attribute.String;
    response_text: Schema.Attribute.Text;
    state: Schema.Attribute.Enumeration<['pending', 'ok', 'ko', 'okwitherrors']> &
      Schema.Attribute.DefaultTo<'pending'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    xml: Schema.Attribute.Text;
  };
}

export interface ApiVerifactuDeclarationVerifactuDeclaration extends Struct.CollectionTypeSchema {
  collectionName: 'verifactu_declarations';
  info: {
    displayName: 'VerifactuDeclaration';
    pluralName: 'verifactu-declarations';
    singularName: 'verifactu-declaration';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::verifactu-declaration.verifactu-declaration'
    > &
      Schema.Attribute.Private;
    pdf: Schema.Attribute.Media<'files'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    url: Schema.Attribute.String;
    version: Schema.Attribute.String;
  };
}

export interface ApiVerifactuVerifactu extends Struct.SingleTypeSchema {
  collectionName: 'verifactus';
  info: {
    displayName: 'Verifactu';
    pluralName: 'verifactu-setting';
    singularName: 'verifactu';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    certificate: Schema.Attribute.Media<'files'>;
    certificate_password: Schema.Attribute.String & Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::verifactu.verifactu'> &
      Schema.Attribute.Private;
    mode: Schema.Attribute.Enumeration<['no', 'test', 'real']>;
    publishedAt: Schema.Attribute.DateTime;
    software_address: Schema.Attribute.String;
    software_date: Schema.Attribute.String;
    software_developerIrsId: Schema.Attribute.String;
    software_developerName: Schema.Attribute.String;
    software_id: Schema.Attribute.String;
    software_location: Schema.Attribute.String;
    software_name: Schema.Attribute.String;
    software_number: Schema.Attribute.String;
    software_useCurrentMulti: Schema.Attribute.Boolean;
    software_useMulti: Schema.Attribute.Boolean;
    software_useOnlyVerifactu: Schema.Attribute.Boolean;
    software_version: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface ApiWorkdayLogWorkdayLog extends Struct.CollectionTypeSchema {
  collectionName: 'workday_logs';
  info: {
    displayName: 'Workday Log';
    pluralName: 'workday-logs';
    singularName: 'workday-log';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    activity: Schema.Attribute.Relation<'oneToOne', 'api::activity.activity'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    date: Schema.Attribute.Date;
    hour_in: Schema.Attribute.Time;
    hour_out: Schema.Attribute.Time;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::workday-log.workday-log'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ApiYearYear extends Struct.CollectionTypeSchema {
  collectionName: 'years';
  info: {
    displayName: 'Years';
    pluralName: 'years';
    singularName: 'year';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    deductible_vat_pct: Schema.Attribute.Decimal;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::year.year'> & Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    working_hours: Schema.Attribute.Decimal;
    year: Schema.Attribute.Integer;
  };
}

export interface PluginContentReleasesRelease extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_releases';
  info: {
    displayName: 'Release';
    pluralName: 'releases';
    singularName: 'release';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    actions: Schema.Attribute.Relation<'oneToMany', 'plugin::content-releases.release-action'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::content-releases.release'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    releasedAt: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<['ready', 'blocked', 'failed', 'done', 'empty']> &
      Schema.Attribute.Required;
    timezone: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesReleaseAction extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_release_actions';
  info: {
    displayName: 'Release Action';
    pluralName: 'release-actions';
    singularName: 'release-action';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentType: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    entryDocumentId: Schema.Attribute.String;
    isEntryValid: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::content-releases.release-action'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    release: Schema.Attribute.Relation<'manyToOne', 'plugin::content-releases.release'>;
    type: Schema.Attribute.Enumeration<['publish', 'unpublish']> & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginI18NLocale extends Struct.CollectionTypeSchema {
  collectionName: 'i18n_locale';
  info: {
    collectionName: 'locales';
    description: '';
    displayName: 'Locale';
    pluralName: 'locales';
    singularName: 'locale';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::i18n.locale'> & Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.SetMinMax<
        {
          max: 50;
          min: 1;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflow extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows';
  info: {
    description: '';
    displayName: 'Workflow';
    name: 'Workflow';
    pluralName: 'workflows';
    singularName: 'workflow';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentTypes: Schema.Attribute.JSON & Schema.Attribute.Required & Schema.Attribute.DefaultTo<'[]'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::review-workflows.workflow'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required & Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    stageRequiredToPublish: Schema.Attribute.Relation<'oneToOne', 'plugin::review-workflows.workflow-stage'>;
    stages: Schema.Attribute.Relation<'oneToMany', 'plugin::review-workflows.workflow-stage'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflowStage extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows_stages';
  info: {
    description: '';
    displayName: 'Stages';
    name: 'Workflow Stage';
    pluralName: 'workflow-stages';
    singularName: 'workflow-stage';
  };
  options: {
    draftAndPublish: false;
    version: '1.1.0';
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.DefaultTo<'#4945FF'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::review-workflows.workflow-stage'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    permissions: Schema.Attribute.Relation<'manyToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    workflow: Schema.Attribute.Relation<'manyToOne', 'plugin::review-workflows.workflow'>;
  };
}

export interface PluginUploadFile extends Struct.CollectionTypeSchema {
  collectionName: 'files';
  info: {
    description: '';
    displayName: 'File';
    pluralName: 'files';
    singularName: 'file';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    alternativeText: Schema.Attribute.Text;
    caption: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    ext: Schema.Attribute.String;
    focalPoint: Schema.Attribute.JSON;
    folder: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'> & Schema.Attribute.Private;
    folderPath: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    formats: Schema.Attribute.JSON;
    hash: Schema.Attribute.String & Schema.Attribute.Required;
    height: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'> & Schema.Attribute.Private;
    mime: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    previewUrl: Schema.Attribute.Text;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    provider_metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    related: Schema.Attribute.Relation<'morphToMany'>;
    size: Schema.Attribute.Decimal & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    url: Schema.Attribute.Text & Schema.Attribute.Required;
    width: Schema.Attribute.Integer;
  };
}

export interface PluginUploadFolder extends Struct.CollectionTypeSchema {
  collectionName: 'upload_folders';
  info: {
    displayName: 'Folder';
    pluralName: 'folders';
    singularName: 'folder';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    children: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    files: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'> & Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    parent: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'>;
    path: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    pathId: Schema.Attribute.Integer & Schema.Attribute.Required & Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsPermission extends Struct.CollectionTypeSchema {
  collectionName: 'up_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.permission'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'plugin::users-permissions.role'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsRole extends Struct.CollectionTypeSchema {
  collectionName: 'up_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.role'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.permission'>;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.String & Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.user'>;
  };
}

export interface PluginUsersPermissionsUser extends Struct.CollectionTypeSchema {
  collectionName: 'users-permissions_user';
  info: {
    displayName: 'user';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    blocked: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    confirmationToken: Schema.Attribute.String & Schema.Attribute.Private;
    confirmed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    cost_by_hour: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    daily_dedications: Schema.Attribute.Relation<'oneToMany', 'api::daily-dedication.daily-dedication'>;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    excel_decimal: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 1;
      }>;
    fullname: Schema.Attribute.String;
    hidden: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    ical: Schema.Attribute.String;
    identity_number: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.user'> &
      Schema.Attribute.Private;
    monthly_salary: Schema.Attribute.Decimal;
    monthly_tax: Schema.Attribute.Decimal;
    multidelivery_discount: Schema.Attribute.Boolean;
    naf: Schema.Attribute.String;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    permissions: Schema.Attribute.Component<'permissions.application-permission', true>;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    role: Schema.Attribute.Relation<'manyToOne', 'plugin::users-permissions.role'>;
    tasks: Schema.Attribute.Relation<'manyToMany', 'api::task.task'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> & Schema.Attribute.Private;
    username: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ContentTypeSchemas {
      'admin::api-token': AdminApiToken;
      'admin::api-token-permission': AdminApiTokenPermission;
      'admin::permission': AdminPermission;
      'admin::role': AdminRole;
      'admin::session': AdminSession;
      'admin::transfer-token': AdminTransferToken;
      'admin::transfer-token-permission': AdminTransferTokenPermission;
      'admin::user': AdminUser;
      'api::activity-type.activity-type': ApiActivityTypeActivityType;
      'api::activity.activity': ApiActivityActivity;
      'api::bank-account.bank-account': ApiBankAccountBankAccount;
      'api::city-route.city-route': ApiCityRouteCityRoute;
      'api::city.city': ApiCityCity;
      'api::config.config': ApiConfigConfig;
      'api::contact-type.contact-type': ApiContactTypeContactType;
      'api::contact.contact': ApiContactContact;
      'api::daily-dedication.daily-dedication': ApiDailyDedicationDailyDedication;
      'api::dedication-type.dedication-type': ApiDedicationTypeDedicationType;
      'api::delivery-type.delivery-type': ApiDeliveryTypeDeliveryType;
      'api::diet.diet': ApiDietDiet;
      'api::document-type.document-type': ApiDocumentTypeDocumentType;
      'api::emitted-grant.emitted-grant': ApiEmittedGrantEmittedGrant;
      'api::emitted-invoice.emitted-invoice': ApiEmittedInvoiceEmittedInvoice;
      'api::estimated-hour.estimated-hour': ApiEstimatedHourEstimatedHour;
      'api::expense-type.expense-type': ApiExpenseTypeExpenseType;
      'api::face-queue.face-queue': ApiFaceQueueFaceQueue;
      'api::festive-type.festive-type': ApiFestiveTypeFestiveType;
      'api::festive.festive': ApiFestiveFestive;
      'api::form-submission.form-submission': ApiFormSubmissionFormSubmission;
      'api::home-menu.home-menu': ApiHomeMenuHomeMenu;
      'api::incidence.incidence': ApiIncidenceIncidence;
      'api::income-type.income-type': ApiIncomeTypeIncomeType;
      'api::justification.justification': ApiJustificationJustification;
      'api::kanban-view.kanban-view': ApiKanbanViewKanbanView;
      'api::legal-form.legal-form': ApiLegalFormLegalForm;
      'api::logo.logo': ApiLogoLogo;
      'api::me.me': ApiMeMe;
      'api::month.month': ApiMonthMonth;
      'api::order.order': ApiOrderOrder;
      'api::orders-import.orders-import': ApiOrdersImportOrdersImport;
      'api::orders-tracking.orders-tracking': ApiOrdersTrackingOrdersTracking;
      'api::payment-method.payment-method': ApiPaymentMethodPaymentMethod;
      'api::payroll.payroll': ApiPayrollPayroll;
      'api::phase-expense.phase-expense': ApiPhaseExpensePhaseExpense;
      'api::phase-income.phase-income': ApiPhaseIncomePhaseIncome;
      'api::pickup.pickup': ApiPickupPickup;
      'api::pivot-table-view.pivot-table-view': ApiPivotTableViewPivotTableView;
      'api::product.product': ApiProductProduct;
      'api::project-document.project-document': ApiProjectDocumentProjectDocument;
      'api::project-likelihood.project-likelihood': ApiProjectLikelihoodProjectLikelihood;
      'api::project-original-phase.project-original-phase': ApiProjectOriginalPhaseProjectOriginalPhase;
      'api::project-phase.project-phase': ApiProjectPhaseProjectPhase;
      'api::project-scope.project-scope': ApiProjectScopeProjectScope;
      'api::project-state.project-state': ApiProjectStateProjectState;
      'api::project-type.project-type': ApiProjectTypeProjectType;
      'api::project.project': ApiProjectProject;
      'api::quote.quote': ApiQuoteQuote;
      'api::received-expense.received-expense': ApiReceivedExpenseReceivedExpense;
      'api::received-grant.received-grant': ApiReceivedGrantReceivedGrant;
      'api::received-income.received-income': ApiReceivedIncomeReceivedIncome;
      'api::received-invoice.received-invoice': ApiReceivedInvoiceReceivedInvoice;
      'api::region.region': ApiRegionRegion;
      'api::route-festive.route-festive': ApiRouteFestiveRouteFestive;
      'api::route-rate.route-rate': ApiRouteRateRouteRate;
      'api::route.route': ApiRouteRoute;
      'api::sector.sector': ApiSectorSector;
      'api::serie.serie': ApiSerieSerie;
      'api::social-entity.social-entity': ApiSocialEntitySocialEntity;
      'api::startup-script.startup-script': ApiStartupScriptStartupScript;
      'api::strategy.strategy': ApiStrategyStrategy;
      'api::task-state.task-state': ApiTaskStateTaskState;
      'api::task.task': ApiTaskTask;
      'api::ticket.ticket': ApiTicketTicket;
      'api::time-counter.time-counter': ApiTimeCounterTimeCounter;
      'api::treasury-validation.treasury-validation': ApiTreasuryValidationTreasuryValidation;
      'api::treasury.treasury': ApiTreasuryTreasury;
      'api::user-festive.user-festive': ApiUserFestiveUserFestive;
      'api::vat-type.vat-type': ApiVatTypeVatType;
      'api::verifactu-chain.verifactu-chain': ApiVerifactuChainVerifactuChain;
      'api::verifactu-declaration.verifactu-declaration': ApiVerifactuDeclarationVerifactuDeclaration;
      'api::verifactu.verifactu': ApiVerifactuVerifactu;
      'api::workday-log.workday-log': ApiWorkdayLogWorkdayLog;
      'api::year.year': ApiYearYear;
      'plugin::content-releases.release': PluginContentReleasesRelease;
      'plugin::content-releases.release-action': PluginContentReleasesReleaseAction;
      'plugin::i18n.locale': PluginI18NLocale;
      'plugin::review-workflows.workflow': PluginReviewWorkflowsWorkflow;
      'plugin::review-workflows.workflow-stage': PluginReviewWorkflowsWorkflowStage;
      'plugin::upload.file': PluginUploadFile;
      'plugin::upload.folder': PluginUploadFolder;
      'plugin::users-permissions.permission': PluginUsersPermissionsPermission;
      'plugin::users-permissions.role': PluginUsersPermissionsRole;
      'plugin::users-permissions.user': PluginUsersPermissionsUser;
    }
  }
}
