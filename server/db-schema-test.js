/**
 * Modul: DB-Schema-Export für Tests
 * Zweck: SQL-Strings aus MIGRATIONS für node:sqlite-Tests exportieren.
 *        Nur für Testzwecke - db.js nutzt die MIGRATIONS direkt intern.
 * Abhängigkeiten: keine
 */

// SQL-String für Migration v1 (gespiegelt aus db.js MIGRATIONS[0].up)
// Änderungen in db.js MIGRATIONS müssen hier synchron gehalten werden.
const MIGRATIONS_SQL = {
  1: `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      avatar_color  TEXT    NOT NULL DEFAULT '#007AFF',
      avatar_data   TEXT,
      role          TEXT    NOT NULL DEFAULT 'member'
                            CHECK(role IN ('admin', 'member')),
      family_role   TEXT    NOT NULL DEFAULT 'other'
                            CHECK(family_role IN ('dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other')),
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT    NOT NULL,
      description     TEXT,
      category        TEXT    NOT NULL DEFAULT 'Sonstiges',
      priority        TEXT    NOT NULL DEFAULT 'medium'
                              CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      status          TEXT    NOT NULL DEFAULT 'open'
                              CHECK(status IN ('open', 'in_progress', 'done')),
      due_date        TEXT,
      due_time        TEXT,
      assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_recurring    INTEGER NOT NULL DEFAULT 0,
      recurrence_rule TEXT,
      parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS shopping_lists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS meals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL,
      meal_type  TEXT    NOT NULL
                         CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
      title      TEXT    NOT NULL,
      notes      TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS shopping_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id         INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      name            TEXT    NOT NULL,
      quantity        TEXT,
      category        TEXT    NOT NULL DEFAULT 'Sonstiges',
      is_checked      INTEGER NOT NULL DEFAULT 0,
      added_from_meal INTEGER REFERENCES meals(id) ON DELETE SET NULL,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS meal_ingredients (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id          INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
      name             TEXT    NOT NULL,
      quantity         TEXT,
      on_shopping_list INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      title                TEXT    NOT NULL,
      description          TEXT,
      start_datetime       TEXT    NOT NULL,
      end_datetime         TEXT,
      all_day              INTEGER NOT NULL DEFAULT 0,
      location             TEXT,
      color                TEXT    NOT NULL DEFAULT '#007AFF',
      icon                 TEXT    NOT NULL DEFAULT 'calendar',
      assigned_to          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_calendar_id TEXT,
      external_source      TEXT    NOT NULL DEFAULT 'local'
                                   CHECK(external_source IN ('local', 'google', 'apple')),
      recurrence_rule      TEXT,
      created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT,
      content    TEXT    NOT NULL,
      color      TEXT    NOT NULL DEFAULT '#FFEB3B',
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT 'Sonstiges',
      phone      TEXT,
      email      TEXT,
      address    TEXT,
      notes      TEXT,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS birthdays (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL,
      birth_date        TEXT    NOT NULL,
      notes             TEXT,
      photo_data        TEXT,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS budget_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT    NOT NULL,
      amount          REAL    NOT NULL,
      category        TEXT    NOT NULL DEFAULT 'Sonstiges',
      subcategory     TEXT    NOT NULL DEFAULT '',
      date            TEXT    NOT NULL,
      is_recurring    INTEGER NOT NULL DEFAULT 0,
      recurrence_rule TEXT,
      recurrence_interval    TEXT    NOT NULL DEFAULT 'monthly',
      recurrence_virtual     INTEGER NOT NULL DEFAULT 0,
      recurrence_full_amount REAL,
      created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS budget_categories (
      key        TEXT PRIMARY KEY,
      name       TEXT    NOT NULL,
      type       TEXT    NOT NULL CHECK(type IN ('expense', 'income')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS budget_subcategories (
      key          TEXT PRIMARY KEY,
      category_key TEXT    NOT NULL REFERENCES budget_categories(key) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE(category_key, name)
    );
    CREATE TABLE IF NOT EXISTS budget_loans (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      title             TEXT    NOT NULL,
      borrower          TEXT    NOT NULL,
      total_amount      REAL    NOT NULL CHECK(total_amount > 0),
      installment_count INTEGER NOT NULL CHECK(installment_count > 0),
      start_month       TEXT    NOT NULL,
      notes             TEXT,
      status            TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active', 'paid')),
      created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS budget_loan_payments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id            INTEGER NOT NULL REFERENCES budget_loans(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL CHECK(installment_number > 0),
      amount             REAL    NOT NULL CHECK(amount > 0),
      paid_date          TEXT    NOT NULL,
      budget_entry_id    INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
      created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE(loan_id, installment_number)
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      token_hash   TEXT    NOT NULL UNIQUE,
      token_prefix TEXT    NOT NULL,
      created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TEXT,
      revoked_at   TEXT,
      last_used_at TEXT,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
      AFTER UPDATE ON users FOR EACH ROW
      BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
      AFTER UPDATE ON tasks FOR EACH ROW
      BEGIN UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_shopping_lists_updated_at
      AFTER UPDATE ON shopping_lists FOR EACH ROW
      BEGIN UPDATE shopping_lists SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_shopping_items_updated_at
      AFTER UPDATE ON shopping_items FOR EACH ROW
      BEGIN UPDATE shopping_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_meals_updated_at
      AFTER UPDATE ON meals FOR EACH ROW
      BEGIN UPDATE meals SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_meal_ingredients_updated_at
      AFTER UPDATE ON meal_ingredients FOR EACH ROW
      BEGIN UPDATE meal_ingredients SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_calendar_events_updated_at
      AFTER UPDATE ON calendar_events FOR EACH ROW
      BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_notes_updated_at
      AFTER UPDATE ON notes FOR EACH ROW
      BEGIN UPDATE notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_contacts_updated_at
      AFTER UPDATE ON contacts FOR EACH ROW
      BEGIN UPDATE contacts SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_birthdays_updated_at
      AFTER UPDATE ON birthdays FOR EACH ROW
      BEGIN UPDATE birthdays SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_budget_entries_updated_at
      AFTER UPDATE ON budget_entries FOR EACH ROW
      BEGIN UPDATE budget_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_budget_loans_updated_at
      AFTER UPDATE ON budget_loans FOR EACH ROW
      BEGIN UPDATE budget_loans SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to    ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date       ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_shopping_items_list  ON shopping_items(list_id);
    CREATE INDEX IF NOT EXISTS idx_meals_date           ON meals(date);
    CREATE INDEX IF NOT EXISTS idx_calendar_start       ON calendar_events(start_datetime);
    CREATE INDEX IF NOT EXISTS idx_calendar_assigned    ON calendar_events(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_notes_pinned         ON notes(pinned);
    CREATE INDEX IF NOT EXISTS idx_budget_date          ON budget_entries(date);
    CREATE INDEX IF NOT EXISTS idx_budget_created_by    ON budget_entries(created_by);
    CREATE INDEX IF NOT EXISTS idx_budget_loans_status  ON budget_loans(status);
    CREATE INDEX IF NOT EXISTS idx_budget_loans_start_month ON budget_loans(start_month);
    CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_loan ON budget_loan_payments(loan_id);
    CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_paid_date ON budget_loan_payments(paid_date);
    CREATE INDEX IF NOT EXISTS idx_birthdays_name       ON birthdays(name);
    CREATE INDEX IF NOT EXISTS idx_birthdays_birth_date ON birthdays(birth_date);
    CREATE INDEX IF NOT EXISTS idx_birthdays_created_by ON birthdays(created_by);
    CREATE INDEX IF NOT EXISTS idx_birthdays_calendar_ref ON birthdays(calendar_event_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_hash      ON api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_created_by ON api_tokens(created_by);

    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS event_assignments (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
  `,
  2: `
    CREATE TABLE IF NOT EXISTS sync_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_external_id ON calendar_events(external_calendar_id);
  `,
  8: `
    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event')),
      entity_id   INTEGER NOT NULL,
      remind_at   TEXT    NOT NULL,
      dismissed   INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_entity ON reminders(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user   ON reminders(created_by);
  `,
  10: `
    CREATE TABLE IF NOT EXISTS ics_subscriptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      url           TEXT    NOT NULL,
      color         TEXT    NOT NULL DEFAULT '#6366f1',
      shared        INTEGER NOT NULL DEFAULT 0,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      etag          TEXT,
      last_modified TEXT,
      last_sync     TEXT,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `,
  11: `
    CREATE TABLE calendar_events (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      title                TEXT    NOT NULL,
      description          TEXT,
      start_datetime       TEXT    NOT NULL,
      end_datetime         TEXT,
      all_day              INTEGER NOT NULL DEFAULT 0,
      location             TEXT,
      color                TEXT    NOT NULL DEFAULT '#007AFF',
      icon                 TEXT    NOT NULL DEFAULT 'calendar',
      assigned_to          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_calendar_id TEXT,
      external_source      TEXT    NOT NULL DEFAULT 'local'
                                   CHECK(external_source IN ('local', 'google', 'apple', 'ics')),
      recurrence_rule      TEXT,
      subscription_id      INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
      user_modified        INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sub_extid
      ON calendar_events (subscription_id, external_calendar_id)
      WHERE subscription_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_calendar_sub ON calendar_events(subscription_id);
  `,
  12: `
    DROP INDEX IF EXISTS idx_calendar_sub_extid;
    CREATE UNIQUE INDEX idx_calendar_sub_extid
      ON calendar_events (subscription_id, external_calendar_id);
  `,
  13: `
    CREATE TABLE IF NOT EXISTS recipes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL,
      notes      TEXT,
      recipe_url TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id  INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      quantity   TEXT,
      category   TEXT    NOT NULL DEFAULT 'Sonstiges',
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
    CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

    CREATE TRIGGER IF NOT EXISTS trg_recipes_updated_at
      AFTER UPDATE ON recipes FOR EACH ROW
      BEGIN UPDATE recipes SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    CREATE TRIGGER IF NOT EXISTS trg_recipe_ingredients_updated_at
      AFTER UPDATE ON recipe_ingredients FOR EACH ROW
      BEGIN UPDATE recipe_ingredients SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    ALTER TABLE meals ADD COLUMN recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_meals_recipe_id ON meals(recipe_id);
  `,
  14: `
    ALTER TABLE calendar_events ADD COLUMN icon TEXT NOT NULL DEFAULT 'calendar';
  `,
  15: `
    UPDATE calendar_events SET icon = 'drill' WHERE icon = 'tooth';
  `,
  16: `
    ALTER TABLE contacts ADD COLUMN family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_family_user
      ON contacts(family_user_id) WHERE family_user_id IS NOT NULL;

    ALTER TABLE birthdays ADD COLUMN family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_birthdays_family_user
      ON birthdays(family_user_id) WHERE family_user_id IS NOT NULL;

    INSERT INTO contacts (name, category, family_user_id)
    SELECT display_name, 'Sonstiges', id
    FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM contacts WHERE contacts.family_user_id = users.id
    );
  `,
  17: `
    UPDATE calendar_events SET icon = 'tooth' WHERE icon = 'drill';
  `,
  18: `
    CREATE TABLE tasks_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT    NOT NULL,
      description     TEXT,
      category        TEXT    NOT NULL DEFAULT 'Sonstiges',
      priority        TEXT    NOT NULL DEFAULT 'none'
                              CHECK(priority IN ('none', 'low', 'medium', 'high', 'urgent')),
      status          TEXT    NOT NULL DEFAULT 'open'
                              CHECK(status IN ('open', 'in_progress', 'done', 'archived')),
      due_date        TEXT,
      due_time        TEXT,
      assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_recurring    INTEGER NOT NULL DEFAULT 0,
      recurrence_rule TEXT,
      parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    INSERT INTO tasks_new
    SELECT * FROM tasks;

    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;

    CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned       ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_task_id);
  `,
  19: `
    CREATE TABLE IF NOT EXISTS family_documents (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      description      TEXT,
      category         TEXT    NOT NULL DEFAULT 'other'
                                CHECK(category IN ('medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other')),
      status           TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active', 'archived')),
      visibility       TEXT    NOT NULL DEFAULT 'family'
                                CHECK(visibility IN ('family', 'restricted', 'private')),
      original_name    TEXT    NOT NULL,
      mime_type        TEXT    NOT NULL,
      file_size        INTEGER NOT NULL,
      content_data     TEXT    NOT NULL,
      storage_provider TEXT    NOT NULL DEFAULT 'local'
                                CHECK(storage_provider IN ('local', 'external')),
      storage_key      TEXT,
      created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS family_document_access (
      document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (document_id, user_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_family_documents_updated_at
      AFTER UPDATE ON family_documents FOR EACH ROW
      BEGIN UPDATE family_documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    CREATE INDEX IF NOT EXISTS idx_family_documents_status     ON family_documents(status);
    CREATE INDEX IF NOT EXISTS idx_family_documents_category   ON family_documents(category);
    CREATE INDEX IF NOT EXISTS idx_family_documents_created_by ON family_documents(created_by);
    CREATE INDEX IF NOT EXISTS idx_family_document_access_user ON family_document_access(user_id);
  `,
  20: `
    ALTER TABLE calendar_events ADD COLUMN attachment_name TEXT;
    ALTER TABLE calendar_events ADD COLUMN attachment_mime TEXT;
    ALTER TABLE calendar_events ADD COLUMN attachment_size INTEGER;
    ALTER TABLE calendar_events ADD COLUMN attachment_data TEXT;
  `,
  21: `
    CREATE TABLE IF NOT EXISTS budget_loans (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      title             TEXT    NOT NULL,
      borrower          TEXT    NOT NULL,
      total_amount      REAL    NOT NULL CHECK(total_amount > 0),
      installment_count INTEGER NOT NULL CHECK(installment_count > 0),
      start_month       TEXT    NOT NULL,
      notes             TEXT,
      status            TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active', 'paid')),
      created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS budget_loan_payments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id            INTEGER NOT NULL REFERENCES budget_loans(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL CHECK(installment_number > 0),
      amount             REAL    NOT NULL CHECK(amount > 0),
      paid_date          TEXT    NOT NULL,
      budget_entry_id    INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
      created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE(loan_id, installment_number)
    );

    CREATE TRIGGER IF NOT EXISTS trg_budget_loans_updated_at
      AFTER UPDATE ON budget_loans FOR EACH ROW
      BEGIN UPDATE budget_loans SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    CREATE INDEX IF NOT EXISTS idx_budget_loans_status ON budget_loans(status);
    CREATE INDEX IF NOT EXISTS idx_budget_loans_start_month ON budget_loans(start_month);
    CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_loan ON budget_loan_payments(loan_id);
    CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_paid_date ON budget_loan_payments(paid_date);
  `,
  42: `
    ALTER TABLE users ADD COLUMN oidc_sub      TEXT;
    ALTER TABLE users ADD COLUMN oidc_provider TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub
      ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
  `,
  44: `
    CREATE VIRTUAL TABLE search_index USING fts5(
      entity UNINDEXED,
      entity_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );

    CREATE TRIGGER trg_search_tasks_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
    END;
    CREATE TRIGGER trg_search_tasks_ad AFTER DELETE ON tasks BEGIN
      DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
    END;
    CREATE TRIGGER trg_search_tasks_au AFTER UPDATE ON tasks BEGIN
      DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
    END;

    CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('event', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
    END;
    CREATE TRIGGER trg_search_events_ad AFTER DELETE ON calendar_events BEGIN
      DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
    END;
    CREATE TRIGGER trg_search_events_au AFTER UPDATE ON calendar_events BEGIN
      DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('event', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
    END;

    CREATE TRIGGER trg_search_notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('note', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''));
    END;
    CREATE TRIGGER trg_search_notes_ad AFTER DELETE ON notes BEGIN
      DELETE FROM search_index WHERE entity = 'note' AND entity_id = OLD.id;
    END;
    CREATE TRIGGER trg_search_notes_au AFTER UPDATE ON notes BEGIN
      DELETE FROM search_index WHERE entity = 'note' AND entity_id = OLD.id;
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('note', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''));
    END;

    CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('contact', NEW.id, COALESCE(NEW.name, ''),
              COALESCE(NEW.phone, '') || ' ' || COALESCE(NEW.email, ''));
    END;
    CREATE TRIGGER trg_search_contacts_ad AFTER DELETE ON contacts BEGIN
      DELETE FROM search_index WHERE entity = 'contact' AND entity_id = OLD.id;
    END;
    CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
      DELETE FROM search_index WHERE entity = 'contact' AND entity_id = OLD.id;
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('contact', NEW.id, COALESCE(NEW.name, ''),
              COALESCE(NEW.phone, '') || ' ' || COALESCE(NEW.email, ''));
    END;

    CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('item', NEW.id, COALESCE(NEW.name, ''), '');
    END;
    CREATE TRIGGER trg_search_items_ad AFTER DELETE ON shopping_items BEGIN
      DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
    END;
    CREATE TRIGGER trg_search_items_au AFTER UPDATE ON shopping_items BEGIN
      DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
      INSERT INTO search_index (entity, entity_id, title, body)
      VALUES ('item', NEW.id, COALESCE(NEW.name, ''), '');
    END;

    INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'task', id, COALESCE(title, ''), COALESCE(description, '') FROM tasks;
    INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'event', id, COALESCE(title, ''), COALESCE(description, '') FROM calendar_events;
    INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'note', id, COALESCE(title, ''), COALESCE(content, '') FROM notes;
    INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'contact', id, COALESCE(name, ''),
             COALESCE(phone, '') || ' ' || COALESCE(email, '') FROM contacts;
    INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'item', id, COALESCE(name, ''), '' FROM shopping_items;
  `,
  61: `
    ALTER TABLE users ADD COLUMN calendar_feed_token TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_feed_token
      ON users(calendar_feed_token)
      WHERE calendar_feed_token IS NOT NULL;
  `,
  62: `
    ALTER TABLE reminders ADD COLUMN pushed_at TEXT;
  `,
};

export { MIGRATIONS_SQL };
