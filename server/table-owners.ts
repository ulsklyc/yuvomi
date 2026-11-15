/**
 * Module: table ownership (phase 2, section A, decision E4)
 * Purpose: Every table of the schema -> the one module that owns it. The owner is the
 *          module whose code may write the table; sections B, D and F of phase 2 route
 *          every read of a foreign table through the owner's read function. Plain data:
 *          nothing in the running server imports this file yet.
 * Ratchet: test:table-ownership builds the schema the way the running server has it
 *          (all migrations plus the tables created at runtime) and demands exactly one
 *          line here per table, no line for a table that does not exist, and an owner from
 *          OWNERS. A new table needs a new line; the owner is a design decision.
 * Owners:  the fifteen permission module keys of PERMISSION_MODULES (server/authorize/catalog.ts)
 *          plus five owners that no member permission gates, each explained in OWNERS.
 * Name rule, as applied (first match wins):
 *   1. Decided by name: users, sync_config, sessions, schema_migrations, search_index and
 *      its FTS5 shadow tables search_index_* -> core; reminders, notification_deliveries ->
 *      delivery; api_tokens, split_expense_guest_users -> auth (a guest is an account kind
 *      that decides what an account may reach); health_care_grants -> health;
 *      contacts -> contacts.
 *   2. The table's stem names a module: budget_*, expense_*, expenses, recurring_expenses,
 *      settlement*, subscription_* -> budget (split expenses and subscriptions sit in the
 *      budget scope, server/scopes.js; their guest accounts are decided in rule 1);
 *      calendar_*, caldav_*, event_*, external_calendar*, google_calendar_*,
 *      ics_subscription*, local_calendars, outlook_* -> calendar;
 *      contact_*, carddav_* -> contacts; cycle_*, health_*, medication* -> health;
 *      family_document*, dms_* -> documents; meal_*, meals, recipe_*, recipes -> meals;
 *      note_*, notes -> notes; task_*, tasks -> tasks; display_* -> display;
 *      notification_*, push_* -> delivery; housekeeping_*, inventory_*, pantry_*, reward_*,
 *      schedule_*, shopping_*, waste_* -> the module of that name.
 *   3. A table named after a nav id goes to the module that lists it: birthdays -> calendar.
 *   4. No clear answer from the name: decided on 2026-11-12 by what the table is
 *      (access_permissions, device_pairing_codes, invites, password_resets,
 *      user_recovery_codes, user_totp -> auth; idempotency_keys -> core;
 *      holiday_cache -> calendar; quick_links -> dashboard).
 * Not listed: temp.search_vocab (server/services/search.js) is an fts5vocab view over
 * search_index in the temp schema of one connection; it holds no data of its own.
 * Erasable TS syntax only (runs through type stripping, no build).
 */

export const OWNERS = Object.freeze([
  // The fifteen permission modules, in the order of PERMISSION_MODULES.
  'calendar', 'tasks', 'notes', 'contacts', 'meals', 'shopping', 'pantry', 'inventory',
  'budget', 'documents', 'housekeeping', 'waste', 'rewards', 'health', 'schedule',
  // The household and the server itself: accounts, schema bookkeeping, sessions, sync
  // settings, the search index, request replay keys.
  'core',
  // Who may sign in and what they may reach: tokens, second factor, invitations, resets,
  // pairing codes, per-member module rights.
  'auth',
  // What goes out to a person: reminders, the delivery log, channels, push endpoints.
  'delivery',
  // The paired wall tablets, their devices and pairing codes (services/display-accounts.js).
  'display',
  // The start page's own data (quick links); server/scopes.js gates it under `dashboard`.
  'dashboard',
] as const);

type Owner = (typeof OWNERS)[number];

/** Table -> owner, sorted by table name, one line per table. */
export const TABLE_OWNERS: Readonly<Record<string, Owner>> = Object.freeze({
  access_permissions: 'auth', // the per-member module rights server/authorize/catalog.ts resolves
  api_tokens: 'auth',
  birthdays: 'calendar',
  budget_accounts: 'budget',
  budget_categories: 'budget',
  budget_entries: 'budget',
  budget_entry_attachments: 'budget',
  budget_entry_responsibles: 'budget',
  budget_loan_payments: 'budget',
  budget_loans: 'budget',
  budget_plans: 'budget',
  budget_recurrence_skipped: 'budget',
  budget_series: 'budget',
  budget_series_responsibles: 'budget',
  budget_subcategories: 'budget',
  budget_subscriptions: 'budget',
  caldav_accounts: 'calendar',
  caldav_calendar_selection: 'calendar',
  caldav_reminder_assignees: 'calendar',
  caldav_reminder_selection: 'calendar',
  caldav_todo_pending_deletions: 'calendar',
  caldav_upload_attempts: 'calendar',
  calendar_event_exceptions: 'calendar',
  calendar_events: 'calendar',
  calendar_pending_deletions: 'calendar',
  carddav_accounts: 'contacts',
  carddav_addressbook_selection: 'contacts',
  contact_addresses: 'contacts',
  contact_categories: 'contacts',
  contact_emails: 'contacts',
  contact_phones: 'contacts',
  contacts: 'contacts',
  cycle_day_log_feelings: 'health',
  cycle_day_log_symptoms: 'health',
  cycle_day_logs: 'health',
  cycle_periods: 'health',
  cycle_reminder_anchors: 'health',
  cycle_settings: 'health',
  device_pairing_codes: 'auth', // a code that signs a person in on a phone
  display_accounts: 'display',
  display_devices: 'display',
  display_pairing_codes: 'display',
  dms_accounts: 'documents',
  event_assignments: 'calendar',
  expense_activity: 'budget',
  expense_attachments: 'budget',
  expense_comments: 'budget',
  expense_group_members: 'budget',
  expense_groups: 'budget',
  expense_ledger_entries: 'budget',
  expense_splits: 'budget',
  expenses: 'budget',
  external_calendar_assignees: 'calendar',
  external_calendars: 'calendar',
  family_document_access: 'documents',
  family_document_folders: 'documents',
  family_documents: 'documents',
  google_calendar_selection: 'calendar',
  health_activities: 'health',
  health_care_grants: 'health',
  health_fasting_settings: 'health',
  health_fasts: 'health',
  health_lab_reports: 'health',
  health_lab_results: 'health',
  health_nutrition_entries: 'health',
  health_nutrition_targets: 'health',
  health_prevention_records: 'health',
  health_prevention_types: 'health',
  health_visibility_defaults: 'health',
  health_vitals: 'health',
  holiday_cache: 'calendar', // the public holidays the calendar shows
  housekeeping_decay_tasks: 'housekeeping',
  housekeeping_maintenance_log: 'housekeeping',
  housekeeping_supply_requests: 'housekeeping',
  housekeeping_work_sessions: 'housekeeping',
  housekeeping_workers: 'housekeeping',
  ics_subscription_assignees: 'calendar',
  ics_subscriptions: 'calendar',
  idempotency_keys: 'core', // request replay keys of middleware/idempotency.js
  inventory_categories: 'inventory',
  inventory_item_dates: 'inventory',
  inventory_item_documents: 'inventory',
  inventory_item_entries: 'inventory',
  inventory_item_service_log: 'inventory',
  inventory_items: 'inventory',
  inventory_locations: 'inventory',
  invites: 'auth', // an invitation creates an account
  local_calendars: 'calendar',
  meal_ingredients: 'meals',
  meal_recurrence_exceptions: 'meals',
  meal_recurrence_ingredients: 'meals',
  meal_recurrence_templates: 'meals',
  meals: 'meals',
  medication_logs: 'health',
  medication_schedules: 'health',
  medications: 'health',
  note_categories: 'notes',
  note_category_assignments: 'notes',
  notes: 'notes',
  notification_channels: 'delivery',
  notification_deliveries: 'delivery',
  outlook_accounts: 'calendar',
  outlook_calendar_selection: 'calendar',
  outlook_event_links: 'calendar',
  pantry_items: 'pantry',
  pantry_locations: 'pantry',
  pantry_products: 'pantry',
  password_resets: 'auth',
  push_subscriptions: 'delivery',
  quick_links: 'dashboard', // server/scopes.js gates its route under the dashboard key
  recipe_ingredient_pantry_matches: 'meals',
  recipe_ingredients: 'meals',
  recipe_provider_accounts: 'meals',
  recipes: 'meals',
  recurring_expenses: 'budget',
  reminders: 'delivery',
  reward_allowances: 'rewards',
  reward_catalog: 'rewards',
  reward_ledger: 'rewards',
  reward_money_accounts: 'rewards',
  reward_participants: 'rewards',
  reward_redemptions: 'rewards',
  schedule_custom_field_values: 'schedule',
  schedule_custom_fields: 'schedule',
  schedule_extra_shifts: 'schedule',
  schedule_overrides: 'schedule',
  schedule_pattern_days: 'schedule',
  schedule_patterns: 'schedule',
  schedule_reminder_entries: 'schedule',
  schedule_shift_type_fields: 'schedule',
  schedule_shift_types: 'schedule',
  schema_migrations: 'core',
  search_index: 'core',
  search_index_config: 'core',
  search_index_content: 'core',
  search_index_data: 'core',
  search_index_docsize: 'core',
  search_index_idx: 'core',
  sessions: 'core',
  settlement_entries: 'budget',
  settlements: 'budget',
  shopping_categories: 'shopping',
  shopping_item_tags: 'shopping',
  shopping_items: 'shopping',
  shopping_list_changes: 'shopping',
  shopping_lists: 'shopping',
  shopping_move_notices: 'shopping',
  shopping_purchases: 'shopping',
  shopping_stores: 'shopping',
  split_expense_guest_users: 'auth', // an account kind, not budget data
  subscription_categories: 'budget',
  subscription_exchange_rates: 'budget',
  subscription_payment_methods: 'budget',
  subscription_settings: 'budget',
  sync_config: 'core',
  task_assignments: 'tasks',
  task_categories: 'tasks',
  task_comments: 'tasks',
  task_completions: 'tasks',
  task_documents: 'tasks',
  task_rotation_pool: 'tasks',
  task_tags: 'tasks',
  tasks: 'tasks',
  user_recovery_codes: 'auth', // second-factor recovery codes, not users
  user_totp: 'auth', // the second factor, not users
  users: 'core',
  waste_imported_pickups: 'waste',
  waste_one_off_pickups: 'waste',
  waste_reminder_entries: 'waste',
  waste_reminder_settings: 'waste',
  waste_schedule_overrides: 'waste',
  waste_schedules: 'waste',
  waste_source_mapping_types: 'waste',
  waste_source_mappings: 'waste',
  waste_sources: 'waste',
  waste_types: 'waste',
});
