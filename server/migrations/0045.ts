export default {
    version: 45,
    description: 'CalDAV reminder (VTODO) sync: list selection + external linkage on tasks and shopping_items',
    up: `
      -- Reminder-list selection per CalDAV account (Apple Reminders = VTODO collections).
      -- Reused caldav_accounts; each list maps to the tasks or shopping module.
      CREATE TABLE caldav_reminder_selection (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id     INTEGER NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        list_url       TEXT    NOT NULL,
        list_name      TEXT    NOT NULL,
        target_module  TEXT    NOT NULL DEFAULT 'tasks'
                               CHECK(target_module IN ('tasks', 'shopping')),
        target_list_id INTEGER REFERENCES shopping_lists(id) ON DELETE SET NULL,
        enabled        INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(account_id, list_url)
      );

      CREATE INDEX IF NOT EXISTS idx_caldav_reminder_selection_enabled
        ON caldav_reminder_selection(account_id, enabled);

      -- External linkage for read-only mirroring of remote VTODOs.
      ALTER TABLE tasks ADD COLUMN external_uid        TEXT;
      ALTER TABLE tasks ADD COLUMN external_source     TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE tasks ADD COLUMN external_account_id INTEGER;

      ALTER TABLE shopping_items ADD COLUMN external_uid        TEXT;
      ALTER TABLE shopping_items ADD COLUMN external_source     TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE shopping_items ADD COLUMN external_account_id INTEGER;

      CREATE INDEX IF NOT EXISTS idx_tasks_external
        ON tasks(external_source, external_account_id, external_uid);
      CREATE INDEX IF NOT EXISTS idx_shopping_items_external
        ON shopping_items(external_source, external_account_id, external_uid);
    `,
  };
