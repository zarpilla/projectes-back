import type { Schema, Struct } from '@strapi/strapi';

export interface BudgetLineBudgetLine extends Struct.ComponentSchema {
  collectionName: 'components_budget_line_budget_lines';
  info: {
    displayName: 'BudgetLine';
    pluralName: 'budgetlines';
    singularName: 'budgetline';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    client: Schema.Attribute.Relation<'oneToOne', 'api::contacts.contacts'>;
    concept: Schema.Attribute.String;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    estimated_hours: Schema.Attribute.Component<'hours.hours', true>;
    grant: Schema.Attribute.Relation<'oneToOne', 'api::received-grant.received-grant'>;
    income: Schema.Attribute.Relation<'oneToOne', 'api::received-income.received-income'>;
    income_type: Schema.Attribute.Relation<'oneToOne', 'api::income-type.income-type'>;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::emitted-invoice.emitted-invoice'>;
    paid: Schema.Attribute.Boolean;
    quantity: Schema.Attribute.Decimal;
    total_amount: Schema.Attribute.Decimal;
    total_estimated_hours: Schema.Attribute.Decimal;
  };
}

export interface BudgetLineSimpleExpense extends Struct.ComponentSchema {
  collectionName: 'components_budget_line_simple_expenses';
  info: {
    displayName: 'SimpleExpense';
    pluralName: 'simpleexpenses';
    singularName: 'simpleexpense';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    concept: Schema.Attribute.String;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    expense_type: Schema.Attribute.Relation<'oneToOne', 'api::expense-type.expense-type'>;
    quantity: Schema.Attribute.Decimal;
    total_amount: Schema.Attribute.Decimal;
  };
}

export interface BudgetLineSimpleIncome extends Struct.ComponentSchema {
  collectionName: 'components_budget_line_simple_incomes';
  info: {
    displayName: 'SimpleIncome';
    pluralName: 'simpleincomes';
    singularName: 'simpleincome';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    concept: Schema.Attribute.String;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    estimated_hours: Schema.Attribute.Component<'hours.hours', true>;
    income_type: Schema.Attribute.Relation<'oneToOne', 'api::income-type.income-type'>;
    quantity: Schema.Attribute.Decimal;
    total_amount: Schema.Attribute.Decimal;
    total_estimated_hours: Schema.Attribute.Decimal;
  };
}

export interface ContactContactData extends Struct.ComponentSchema {
  collectionName: 'components_contact_contact_data';
  info: {
    displayName: 'ContactData';
    pluralName: 'contactdatas';
    singularName: 'contactdata';
  };
  attributes: {
    address: Schema.Attribute.String;
    city: Schema.Attribute.String;
    country: Schema.Attribute.String;
    name: Schema.Attribute.String;
    nif: Schema.Attribute.String;
    postcode: Schema.Attribute.String;
    state: Schema.Attribute.String;
  };
}

export interface DedicationDedication extends Struct.ComponentSchema {
  collectionName: 'components_dedication_dedications';
  info: {
    displayName: 'dedication';
    pluralName: 'dedications';
    singularName: 'dedication';
  };
  attributes: {
    comment: Schema.Attribute.String;
    costbyhour: Schema.Attribute.Decimal;
    date: Schema.Attribute.Date;
    dedication_type: Schema.Attribute.Relation<'oneToOne', 'api::dedication-type.dedication-type'>;
    hours: Schema.Attribute.Decimal;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface ExpenseExpense extends Struct.ComponentSchema {
  collectionName: 'components_expense_expenses';
  info: {
    displayName: 'Expense';
    pluralName: 'expenses';
    singularName: 'expense';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    concept: Schema.Attribute.String;
    date: Schema.Attribute.Date;
    date_estimate_document: Schema.Attribute.Date;
    diet: Schema.Attribute.Relation<'oneToOne', 'api::diet.diet'>;
    expense: Schema.Attribute.Relation<'oneToOne', 'api::received-expense.received-expense'>;
    expense_type: Schema.Attribute.Relation<'oneToOne', 'api::expense-type.expense-type'>;
    grant: Schema.Attribute.Relation<'oneToOne', 'api::emitted-grant.emitted-grant'>;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::received-invoice.received-invoice'>;
    paid: Schema.Attribute.Boolean;
    provider: Schema.Attribute.Relation<'oneToOne', 'api::contacts.contacts'>;
    quantity: Schema.Attribute.Decimal;
    ticket: Schema.Attribute.Relation<'oneToOne', 'api::ticket.ticket'>;
    total_amount: Schema.Attribute.Decimal;
  };
}

export interface GrantableContactGrantableContact extends Struct.ComponentSchema {
  collectionName: 'components_grantable_contact_grantable_contacts';
  info: {
    displayName: 'grantable_contact';
    pluralName: 'grantable_contacts';
    singularName: 'grantable_contact';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    contact: Schema.Attribute.Relation<'oneToOne', 'api::contacts.contacts'>;
  };
}

export interface GrantableGrantableYear extends Struct.ComponentSchema {
  collectionName: 'components_grantable_grantable_years';
  info: {
    displayName: 'Grantable_year';
    pluralName: 'grantable_years';
    singularName: 'grantable_year';
  };
  attributes: {
    grantable_amount: Schema.Attribute.Decimal;
    grantable_amount_total: Schema.Attribute.Decimal;
    grantable_cofinancing: Schema.Attribute.Decimal;
    grantable_structural_expenses: Schema.Attribute.Decimal;
    grantable_structural_expenses_justify_invoices: Schema.Attribute.Decimal;
    year: Schema.Attribute.Relation<'oneToOne', 'api::year.year'>;
  };
}

export interface HomegroupHomegroup extends Struct.ComponentSchema {
  collectionName: 'components_homegroup_homegroups';
  info: {
    displayName: 'homegroup';
    pluralName: 'homegroups';
    singularName: 'homegroup';
  };
  attributes: {
    items: Schema.Attribute.Component<'homeitem.home-item', true>;
    name: Schema.Attribute.String;
  };
}

export interface HomeitemHomeItem extends Struct.ComponentSchema {
  collectionName: 'components_homeitem_home_items';
  info: {
    displayName: 'homeItem';
    pluralName: 'homeitems';
    singularName: 'homeitem';
  };
  attributes: {
    navigate: Schema.Attribute.String;
    open: Schema.Attribute.String;
    text: Schema.Attribute.String;
  };
}

export interface HoursHours extends Struct.ComponentSchema {
  collectionName: 'components_hours_hours';
  info: {
    displayName: 'hours';
    pluralName: 'hourses';
    singularName: 'hours';
  };
  attributes: {
    amount: Schema.Attribute.Decimal;
    comment: Schema.Attribute.String;
    from: Schema.Attribute.Date;
    month: Schema.Attribute.Relation<'oneToOne', 'api::month.month'>;
    monthly_quantity: Schema.Attribute.Decimal;
    quantity: Schema.Attribute.Decimal;
    quantity_type: Schema.Attribute.Enumeration<['total', 'week', 'month']> &
      Schema.Attribute.DefaultTo<'total'>;
    to: Schema.Attribute.Date;
    total_amount: Schema.Attribute.Decimal;
    users_permissions_user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    year: Schema.Attribute.Relation<'oneToOne', 'api::year.year'>;
  };
}

export interface InvoiceLineInvoiceCreation extends Struct.ComponentSchema {
  collectionName: 'components_invoice_line_invoice_creations';
  info: {
    displayName: 'InvoiceCreation';
    pluralName: 'invoicecreations';
    singularName: 'invoicecreation';
  };
  attributes: {
    base: Schema.Attribute.Decimal;
    concept: Schema.Attribute.String;
    quantity: Schema.Attribute.Decimal;
    reset_hours: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
  };
}

export interface InvoiceLineInvoiceLine extends Struct.ComponentSchema {
  collectionName: 'components_invoice_line_invoice_lines';
  info: {
    displayName: 'InvoiceLine';
    pluralName: 'invoicelines';
    singularName: 'invoiceline';
  };
  attributes: {
    base: Schema.Attribute.Decimal;
    comments: Schema.Attribute.Text;
    concept: Schema.Attribute.String;
    discount: Schema.Attribute.Decimal;
    irpf: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<15>;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
    quantity: Schema.Attribute.Decimal;
    vat: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<21>;
  };
}

export interface InvoiceLineInvoiceLineExpenses extends Struct.ComponentSchema {
  collectionName: 'components_invoice_line_invoice_line_expenses';
  info: {
    displayName: 'InvoiceLineExpenses';
    pluralName: 'invoicelineexpenseses';
    singularName: 'invoicelineexpenses';
  };
  attributes: {
    base: Schema.Attribute.Decimal;
    comments: Schema.Attribute.Text;
    concept: Schema.Attribute.String;
    discount: Schema.Attribute.Decimal;
    expense_type: Schema.Attribute.Relation<'oneToOne', 'api::expense-type.expense-type'>;
    irpf: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0>;
    quantity: Schema.Attribute.Decimal;
    vat: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<21>;
  };
}

export interface InvoiceLineTicketLine extends Struct.ComponentSchema {
  collectionName: 'components_invoice_line_ticket_lines';
  info: {
    displayName: 'TicketLine';
    pluralName: 'ticketlines';
    singularName: 'ticketline';
  };
  attributes: {
    base: Schema.Attribute.Decimal;
    comments: Schema.Attribute.Text;
    concept: Schema.Attribute.String;
    date: Schema.Attribute.Date;
    discount: Schema.Attribute.Decimal;
    irpf: Schema.Attribute.Decimal;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
    quantity: Schema.Attribute.Decimal;
    vat: Schema.Attribute.Decimal;
  };
}

export interface OptionsOptions extends Struct.ComponentSchema {
  collectionName: 'components_options_options';
  info: {
    displayName: 'Options';
    pluralName: 'optionses';
    singularName: 'options';
  };
  attributes: {
    deductible_vat_pct: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<100>;
    orders: Schema.Attribute.Boolean;
    show_forecast: Schema.Attribute.Boolean;
    showEstimatedHoursInPhases: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    showTasksInGantt: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    structuralExpenses: Schema.Attribute.Boolean;
    treasury: Schema.Attribute.Boolean;
    userHasCostByHour: Schema.Attribute.Boolean;
  };
}

export interface OptionsOrdersOptions extends Struct.ComponentSchema {
  collectionName: 'components_options_orders_options';
  info: {
    displayName: 'orders_options';
    pluralName: 'orders_optionses';
    singularName: 'orders_options';
  };
  attributes: {
    multidelivery_discount: Schema.Attribute.Decimal;
    next_day_limit_hour: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<14>;
  };
}

export interface OptionsQuotes extends Struct.ComponentSchema {
  collectionName: 'components_options_quotes';
  info: {
    displayName: 'quotes';
    pluralName: 'quoteses';
    singularName: 'quotes';
  };
  attributes: {
    autonoma_pct_irpf: Schema.Attribute.Decimal;
    autonoma_pct_other: Schema.Attribute.Decimal;
    autonoma_pct_quota: Schema.Attribute.Decimal;
    autonoma_quota: Schema.Attribute.Decimal;
    diet_amount_total: Schema.Attribute.Decimal;
    diet_amount_without_irpf: Schema.Attribute.Decimal;
    general_pct_irpf: Schema.Attribute.Decimal;
    general_pct_other: Schema.Attribute.Decimal;
    general_pct_quota: Schema.Attribute.Decimal;
    general_quota: Schema.Attribute.Decimal;
  };
}

export interface OrdersIncidenceResponse extends Struct.ComponentSchema {
  collectionName: 'components_orders_incidence_responses';
  info: {
    displayName: 'IncidenceResponse';
    pluralName: 'incidenceresponses';
    singularName: 'incidenceresponse';
  };
  attributes: {
    response_date: Schema.Attribute.DateTime;
    text: Schema.Attribute.Text;
    user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
  };
}

export interface OrdersLines extends Struct.ComponentSchema {
  collectionName: 'components_orders_lines';
  info: {
    displayName: 'lines';
    pluralName: 'lineses';
    singularName: 'lines';
  };
  attributes: {
    kilograms: Schema.Attribute.Decimal;
    name: Schema.Attribute.String;
    nif: Schema.Attribute.String;
    picked_up: Schema.Attribute.Boolean;
    units: Schema.Attribute.Integer;
  };
}

export interface PeriodificationPeriodification extends Struct.ComponentSchema {
  collectionName: 'components_periodification_periodifications';
  info: {
    displayName: 'periodification';
    pluralName: 'periodifications';
    singularName: 'periodification';
  };
  attributes: {
    expenses: Schema.Attribute.Decimal;
    incomes: Schema.Attribute.Decimal;
    real_expenses: Schema.Attribute.Decimal;
    real_incomes: Schema.Attribute.Decimal;
    year: Schema.Attribute.String;
  };
}

export interface PermissionsApplicationPermission extends Struct.ComponentSchema {
  collectionName: 'components_permissions_application_permissions';
  info: {
    displayName: 'Application Permission';
    pluralName: 'application permissions';
    singularName: 'application permission';
  };
  attributes: {
    permission: Schema.Attribute.Enumeration<
      ['projects', 'orders', 'orders_admin', 'orders_delivery', 'hours', 'admin']
    >;
  };
}

export interface ProjectPhaseOriginalProjectPhase extends Struct.ComponentSchema {
  collectionName: 'components_project_phase_original_project_phases';
  info: {
    displayName: 'OriginalProjectPhase';
    pluralName: 'originalprojectphases';
    singularName: 'originalprojectphase';
  };
  attributes: {
    expenses: Schema.Attribute.Component<'budget-line.simple-expense', true>;
    incomes: Schema.Attribute.Component<'budget-line.simple-income', true>;
    name: Schema.Attribute.String;
  };
}

export interface ProjectPhaseProjectPhase extends Struct.ComponentSchema {
  collectionName: 'components_project_phase_project_phases';
  info: {
    displayName: 'ProjectPhase';
    pluralName: 'projectphases';
    singularName: 'projectphase';
  };
  attributes: {
    expenses: Schema.Attribute.Component<'expense.expense', true>;
    incomes: Schema.Attribute.Component<'budget-line.budget-line', true>;
    name: Schema.Attribute.String;
  };
}

export interface ProjectPhaseProjectSubPhase extends Struct.ComponentSchema {
  collectionName: 'components_project_phase_project_sub_phases';
  info: {
    displayName: 'ProjectSubPhase';
    pluralName: 'projectsubphases';
    singularName: 'projectsubphase';
  };
  attributes: {
    name: Schema.Attribute.String;
  };
}

export interface TaskTaskChecklist extends Struct.ComponentSchema {
  collectionName: 'components_task_task_checklists';
  info: {
    displayName: 'TaskChecklist';
    pluralName: 'taskchecklists';
    singularName: 'taskchecklist';
  };
  attributes: {
    created: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    created_date: Schema.Attribute.DateTime;
    done: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    due_date: Schema.Attribute.Date;
    name: Schema.Attribute.String;
    user: Schema.Attribute.Relation<'oneToOne', 'plugin::users-permissions.user'>;
    users: Schema.Attribute.Relation<'oneToMany', 'plugin::users-permissions.user'>;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ComponentSchemas {
      'budget-line.budget-line': BudgetLineBudgetLine;
      'budget-line.simple-expense': BudgetLineSimpleExpense;
      'budget-line.simple-income': BudgetLineSimpleIncome;
      'contact.contact-data': ContactContactData;
      'dedication.dedication': DedicationDedication;
      'expense.expense': ExpenseExpense;
      'grantable-contact.grantable-contact': GrantableContactGrantableContact;
      'grantable.grantable-year': GrantableGrantableYear;
      'homegroup.homegroup': HomegroupHomegroup;
      'homeitem.home-item': HomeitemHomeItem;
      'hours.hours': HoursHours;
      'invoice-line.invoice-creation': InvoiceLineInvoiceCreation;
      'invoice-line.invoice-line': InvoiceLineInvoiceLine;
      'invoice-line.invoice-line-expenses': InvoiceLineInvoiceLineExpenses;
      'invoice-line.ticket-line': InvoiceLineTicketLine;
      'options.options': OptionsOptions;
      'options.orders-options': OptionsOrdersOptions;
      'options.quotes': OptionsQuotes;
      'orders.incidence-response': OrdersIncidenceResponse;
      'orders.lines': OrdersLines;
      'periodification.periodification': PeriodificationPeriodification;
      'permissions.application-permission': PermissionsApplicationPermission;
      'project-phase.original-project-phase': ProjectPhaseOriginalProjectPhase;
      'project-phase.project-phase': ProjectPhaseProjectPhase;
      'project-phase.project-sub-phase': ProjectPhaseProjectSubPhase;
      'task.task-checklist': TaskTaskChecklist;
    }
  }
}
