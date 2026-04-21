/**
 * Modul: Datenbank (Database)
 * Zweck: SQLite/SQLCipher Verbindung, Schema-Migration (versioniert) und Query-Helfer
 * Abhängigkeiten: better-sqlite3
 *
 * SQLCipher-Hinweis:
 *   Verschlüsselung funktioniert nur wenn better-sqlite3 gegen SQLCipher kompiliert wurde.
 *   Im Docker-Container (Dockerfile: libsqlcipher-dev + npm rebuild) ist das gewährleistet.
 *   Ohne DB_ENCRYPTION_KEY gesetzt läuft die App mit unverschlüsseltem SQLite (für Entwicklung).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('DB');

const DB_PATH = process.env.DB_PATH || path.join(import.meta.dirname, '..', 'oikos.db');
const DB_KEY = process.env.DB_ENCRYPTION_KEY;

let db;

// --------------------------------------------------------
// Initialisierung
// --------------------------------------------------------

/**
 * Datenbankverbindung öffnen, SQLCipher-Key setzen, Migrations ausführen.
 * Einmalig beim Serverstart aufrufen.
 * @returns {import('better-sqlite3').Database}
 */
function init() {
  if (db) return db;
  db = new Database(DB_PATH);

  if (DB_KEY) {
    // Nur wirksam wenn Binary gegen SQLCipher kompiliert ist (Docker)
    db.pragma(`key="x'${Buffer.from(DB_KEY, 'utf8').toString('hex')}'"`);

    // Sicherstellen dass die Datenbank tatsächlich entschlüsselbar ist
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch {
      throw new Error('[DB] Falscher Verschlüsselungsschlüssel oder keine SQLCipher-Unterstützung.');
    }
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  migrate();

  log.info(`Verbunden: ${DB_PATH} | Schema v${currentVersion()}`);
  return db;
}

// --------------------------------------------------------
// Migrations-Engine
// --------------------------------------------------------

/**
 * Alle Migrationen in aufsteigender Reihenfolge.
 * Neue Migrations am Ende anhängen - niemals bestehende ändern.
 */
const MIGRATIONS = [
  {
    version: 1,
    description: 'Initiales Schema',
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
  },
  {
    version: 2,
    description: 'Sync-Konfigurationstabelle für Google/Apple Calendar',
    up: `
      CREATE TABLE IF NOT EXISTS sync_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_external_id ON calendar_events(external_calendar_id);
    `,
  },
  {
    version: 3,
    description: 'Wiederkehrende Budget-Einträge: parent-Referenz und Skip-Tabelle',
    up: `
      ALTER TABLE budget_entries ADD COLUMN recurrence_parent_id INTEGER
        REFERENCES budget_entries(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS budget_recurrence_skipped (
        parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
        month     TEXT    NOT NULL,
        PRIMARY KEY (parent_id, month)
      );

      CREATE INDEX IF NOT EXISTS idx_budget_parent ON budget_entries(recurrence_parent_id);
    `,
  },
  {
    version: 4,
    description: 'Priorität "none" erlauben und als Default setzen',
    up: `
      -- SQLite erlaubt kein ALTER CHECK, daher Tabelle neu erstellen
      CREATE TABLE tasks_new (
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

      INSERT INTO tasks_new SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned       ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due            ON tasks(due_date);
    `,
  },
  {
    version: 5,
    description: 'Einkaufskategorien als eigene Tabelle (anpassbar, sortierbar)',
    up: `
      CREATE TABLE IF NOT EXISTS shopping_categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        icon       TEXT    NOT NULL DEFAULT 'tag',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO shopping_categories (name, icon, sort_order) VALUES
        ('Obst & Gemüse',   'apple',           0),
        ('Backwaren',        'wheat',           1),
        ('Milchprodukte',    'milk',            2),
        ('Fleisch & Fisch',  'beef',            3),
        ('Tiefkühl',         'snowflake',       4),
        ('Getränke',         'cup-soda',        5),
        ('Haushalt',         'spray-can',       6),
        ('Drogerie',         'pill',            7),
        ('Sonstiges',        'shopping-basket', 8);
    `,
  },
  {
    version: 6,
    description: 'Rezept-URL für Mahlzeiten',
    up: `
      ALTER TABLE meals ADD COLUMN recipe_url TEXT;
    `,
  },
  {
    version: 7,
    description: 'Kategorie pro Zutat für Einkaufslisten-Transfer',
    up: `
      ALTER TABLE meal_ingredients ADD COLUMN category TEXT NOT NULL DEFAULT 'Sonstiges';
    `,
  },
  {
    version: 8,
    description: 'Erinnerungen (Reminders) für Aufgaben und Kalender-Events',
    up: `
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
  },
  {
    version: 9,
    description: 'Task-Kategorien auf englische Schlüssel migrieren',
    up: `
      UPDATE tasks SET category = CASE category
        WHEN 'Haushalt'   THEN 'household'
        WHEN 'Schule'     THEN 'school'
        WHEN 'Einkauf'    THEN 'shopping'
        WHEN 'Reparatur'  THEN 'repair'
        WHEN 'Gesundheit' THEN 'health'
        WHEN 'Finanzen'   THEN 'finance'
        WHEN 'Freizeit'   THEN 'leisure'
        WHEN 'Sonstiges'  THEN 'misc'
        ELSE category
      END;
    `,
  },
  {
    version: 10,
    description: 'ICS-Abonnements Tabelle',
    up: `
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
  },
  {
    version: 11,
    description: 'calendar_events: external_source ICS, subscription_id, user_modified',
    up: `
      CREATE TABLE calendar_events_new (
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
                                     CHECK(external_source IN ('local', 'google', 'apple', 'ics')),
        recurrence_rule      TEXT,
        subscription_id      INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
        user_modified        INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO calendar_events_new
        (id, title, description, start_datetime, end_datetime, all_day, location, color,
         assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
         subscription_id, user_modified, created_at, updated_at)
      SELECT id, title, description, start_datetime, end_datetime, all_day, location, color,
             assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
             NULL, 0, created_at, updated_at
      FROM calendar_events;

      DROP TRIGGER IF EXISTS trg_calendar_events_updated_at;
      DROP TABLE calendar_events;
      ALTER TABLE calendar_events_new RENAME TO calendar_events;

      CREATE TRIGGER trg_calendar_events_updated_at
        AFTER UPDATE ON calendar_events FOR EACH ROW
        BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_calendar_start       ON calendar_events(start_datetime);
      CREATE INDEX IF NOT EXISTS idx_calendar_assigned    ON calendar_events(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_calendar_external_id ON calendar_events(external_calendar_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_sub         ON calendar_events(subscription_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sub_extid
        ON calendar_events (subscription_id, external_calendar_id)
        WHERE subscription_id IS NOT NULL;
    `,
  },
  {
    version: 12,
    description: 'Rezepte speichern und Mahlzeiten mit Rezepten verknuepfen',
    up: `
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
  },
];

/**
 * Führt alle ausstehenden Migrations in einer Transaktion aus.
 */
function migrate() {
  // Migrations-Versions-Tabelle sicherstellen (außerhalb der Haupt-Transaktion)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));

  if (pending.length === 0) return;

  const runMigration = db.transaction((migration) => {
    db.exec(migration.up);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
    log.info(`Migration ${migration.version} angewendet: ${migration.description}`);
  });

  for (const migration of pending) {
    runMigration(migration);
  }
}

/**
 * Aktuelle Schema-Version zurückgeben.
 * @returns {number}
 */
function currentVersion() {
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Datenbankinstanz zurückgeben.
 * @returns {import('better-sqlite3').Database}
 */
function get() {
  if (!db) throw new Error('[DB] Nicht initialisiert - init() zuerst aufrufen.');
  return db;
}

/**
 * Transaktion-Helfer: Funktion wird atomar ausgeführt.
 * Bei Fehler wird automatisch rollback ausgeführt.
 * @param {Function} fn
 * @returns {any}
 */
function transaction(fn) {
  return get().transaction(fn)();
}

init();   // auto-initialise when module is first imported

export { init, get, transaction, currentVersion };
