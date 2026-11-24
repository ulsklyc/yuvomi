export default {
    version: 1,
    description: 'Initial schema',
    up: `
      -- Benutzer
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    UNIQUE NOT NULL,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        avatar_color  TEXT    NOT NULL DEFAULT '#007AFF',
        role          TEXT    NOT NULL DEFAULT 'member'
                              CHECK(role IN ('admin', 'member')),
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Aufgaben
      CREATE TABLE IF NOT EXISTS tasks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT    NOT NULL,
        description     TEXT,
        category        TEXT    NOT NULL DEFAULT 'Sonstiges',
        priority        TEXT    NOT NULL DEFAULT 'none'
                                CHECK(priority IN ('none', 'low', 'medium', 'high', 'urgent')),
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

      -- Einkaufslisten
      CREATE TABLE IF NOT EXISTS shopping_lists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Essensplan (muss vor shopping_items stehen wegen FK-Referenz)
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

      -- Einkaufsartikel (nach meals, wegen added_from_meal FK)
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

      -- Mahlzeit-Zutaten
      CREATE TABLE IF NOT EXISTS meal_ingredients (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_id          INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        name             TEXT    NOT NULL,
        quantity         TEXT,
        on_shopping_list INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Kalender-Events
      CREATE TABLE IF NOT EXISTS calendar_events (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        title                TEXT    NOT NULL,
        description          TEXT,
        start_datetime       TEXT    NOT NULL,
        end_datetime         TEXT,
        all_day              INTEGER NOT NULL DEFAULT 0,
        location             TEXT,
        color                TEXT    NOT NULL DEFAULT '#007AFF',
        assigned_to          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        external_calendar_id TEXT,
        external_source      TEXT    NOT NULL DEFAULT 'local'
                                     CHECK(external_source IN ('local', 'google', 'apple')),
        recurrence_rule      TEXT,
        created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Pinnwand / Notizen
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

      -- Kontakte
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

      -- Budget
      CREATE TABLE IF NOT EXISTS budget_entries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT    NOT NULL,
        amount          REAL    NOT NULL,
        category        TEXT    NOT NULL DEFAULT 'Sonstiges',
        date            TEXT    NOT NULL,
        is_recurring    INTEGER NOT NULL DEFAULT 0,
        recurrence_rule TEXT,
        created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- --------------------------------------------------------
      -- updated_at Trigger (automatisch bei UPDATE setzen)
      -- --------------------------------------------------------
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

      CREATE TRIGGER IF NOT EXISTS trg_budget_entries_updated_at
        AFTER UPDATE ON budget_entries FOR EACH ROW
        BEGIN UPDATE budget_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- --------------------------------------------------------
      -- Indizes
      -- --------------------------------------------------------
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
    `,
  };
