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
import fs from 'node:fs/promises';
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

  applyEncryptionKey(db);

  if (DB_KEY) {
    // Sicherstellen dass die Datenbank tatsächlich entschlüsselbar ist
    try {
      assertReadable(db);
    } catch {
      throw new Error('[DB] Wrong encryption key or SQLCipher support is unavailable.');
    }
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  migrate();

  log.info(`Connected: ${DB_PATH} | Schema v${currentVersion()}`);
  return db;
}

function applyEncryptionKey(database) {
  if (!DB_KEY) return;
  // Nur wirksam wenn Binary gegen SQLCipher kompiliert ist (Docker)
  database.pragma(`key="x'${Buffer.from(DB_KEY, 'utf8').toString('hex')}'"`);
}

function assertReadable(database) {
  database.prepare('SELECT count(*) FROM sqlite_master').get();
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
  },
  {
    version: 2,
    description: 'Sync configuration table for Google/Apple Calendar',
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
    description: 'Recurring budget entries: parent reference and skip table',
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
    description: 'Allow "none" priority and set it as default',
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
    description: 'Shopping categories as a separate table (customizable, sortable)',
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
    description: 'Recipe URL for meals',
    up: `
      ALTER TABLE meals ADD COLUMN recipe_url TEXT;
    `,
  },
  {
    version: 7,
    description: 'Category per ingredient for shopping list transfer',
    up: `
      ALTER TABLE meal_ingredients ADD COLUMN category TEXT NOT NULL DEFAULT 'Sonstiges';
    `,
  },
  {
    version: 8,
    description: 'Reminders for tasks and calendar events',
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
    description: 'Migrate task categories to English keys',
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
    description: 'ICS subscriptions table',
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
    description: 'calendar_events: replace partial unique index with full index (ON CONFLICT support)',
    up: `
      DROP INDEX IF EXISTS idx_calendar_sub_extid;
      CREATE UNIQUE INDEX idx_calendar_sub_extid
        ON calendar_events (subscription_id, external_calendar_id);
    `,
  },
  {
    version: 13,
    description: 'Recipes table and meal association',
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
  {
    version: 14,
    description: 'External calendar metadata (name, color) and event association',
    up: `
      CREATE TABLE IF NOT EXISTS external_calendars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT    NOT NULL CHECK(source IN ('google', 'apple')),
        external_id TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        color       TEXT,
        UNIQUE(source, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ext_cal_source ON external_calendars(source, external_id);

      ALTER TABLE calendar_events ADD COLUMN calendar_ref_id INTEGER
        REFERENCES external_calendars(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_cal_events_ref ON calendar_events(calendar_ref_id);
    `,
  },
  {
    version: 15,
    description: 'Budget expense categories as stable keys with subcategories',
    up: `
      ALTER TABLE budget_entries ADD COLUMN subcategory TEXT NOT NULL DEFAULT '';

      UPDATE budget_entries
      SET category = CASE category
        WHEN 'Lebensmittel' THEN 'food'
        WHEN 'Miete' THEN 'housing'
        WHEN 'Versicherung' THEN 'financial_other'
        WHEN 'Mobilität' THEN 'transport'
        WHEN 'Freizeit' THEN 'leisure'
        WHEN 'Kleidung' THEN 'shopping_clothing'
        WHEN 'Gesundheit' THEN 'personal_health'
        WHEN 'Bildung' THEN 'education'
        WHEN 'Sonstiges' THEN 'financial_other'
        ELSE category
      END
      WHERE amount < 0;

      UPDATE budget_entries
      SET subcategory = CASE category
        WHEN 'housing' THEN 'rent_mortgage'
        WHEN 'food' THEN 'groceries'
        WHEN 'transport' THEN 'fuel'
        WHEN 'personal_health' THEN 'pharmacy'
        WHEN 'leisure' THEN 'events'
        WHEN 'shopping_clothing' THEN 'clothes_shoes'
        WHEN 'education' THEN 'courses_college'
        WHEN 'financial_other' THEN 'insurance_other'
        ELSE ''
      END
      WHERE amount < 0 AND subcategory = '';

      UPDATE budget_entries
      SET category = 'Sonstiges Einkommen'
      WHERE amount > 0 AND category = 'Sonstiges';
    `,
  },
  {
    version: 16,
    description: 'Move budget categories and subcategories to separate tables',
    up: `
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

      INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order) VALUES
        ('housing', 'Housing / Home', 'expense', 0),
        ('food', 'Food', 'expense', 1),
        ('transport', 'Transport', 'expense', 2),
        ('personal_health', 'Personal Care / Health', 'expense', 3),
        ('leisure', 'Leisure and Entertainment', 'expense', 4),
        ('shopping_clothing', 'Shopping and Clothing', 'expense', 5),
        ('education', 'Education', 'expense', 6),
        ('financial_other', 'Financial Services and Other', 'expense', 7),
        ('Erwerbseinkommen', 'Erwerbseinkommen', 'income', 0),
        ('Kapitalerträge', 'Kapitalerträge', 'income', 1),
        ('Geschenke & Transfers', 'Geschenke & Transfers', 'income', 2),
        ('Sozialleistungen', 'Sozialleistungen', 'income', 3),
        ('Sonstiges Einkommen', 'Sonstiges Einkommen', 'income', 4);

      INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order) VALUES
        ('rent_mortgage', 'housing', 'Rent / Mortgage', 0),
        ('condominium', 'housing', 'Condominium fees', 1),
        ('utilities', 'housing', 'Electricity / Water / Gas', 2),
        ('internet_tv_phone', 'housing', 'Internet / TV / Phone', 3),
        ('renovation_maintenance', 'housing', 'Renovation / Maintenance', 4),
        ('cleaning', 'housing', 'Cleaning', 5),
        ('groceries', 'food', 'Groceries', 0),
        ('restaurants_bars', 'food', 'Restaurants / Bars', 1),
        ('snacks_fast_food', 'food', 'Snacks / Fast Food', 2),
        ('bakery', 'food', 'Bakery', 3),
        ('fuel', 'transport', 'Fuel', 0),
        ('parking_tolls', 'transport', 'Parking / Tolls', 1),
        ('public_transport', 'transport', 'Public transport', 2),
        ('apps_taxi', 'transport', 'Apps / Taxi', 3),
        ('maintenance_insurance', 'transport', 'Maintenance / Insurance', 4),
        ('pharmacy', 'personal_health', 'Pharmacy', 0),
        ('health_insurance', 'personal_health', 'Health insurance', 1),
        ('gym_sports', 'personal_health', 'Gym / Sports', 2),
        ('beauty_cosmetics', 'personal_health', 'Beauty / Cosmetics', 3),
        ('travel', 'leisure', 'Travel', 0),
        ('streaming', 'leisure', 'Streaming', 1),
        ('events', 'leisure', 'Events', 2),
        ('hobbies', 'leisure', 'Hobbies', 3),
        ('clothes_shoes', 'shopping_clothing', 'Clothes / Shoes', 0),
        ('electronics', 'shopping_clothing', 'Electronics', 1),
        ('gifts', 'shopping_clothing', 'Gifts', 2),
        ('courses_college', 'education', 'Courses / College', 0),
        ('school_supplies', 'education', 'School supplies', 1),
        ('languages', 'education', 'Languages', 2),
        ('loans_interest', 'financial_other', 'Loans / Interest', 0),
        ('bank_fees', 'financial_other', 'Bank fees', 1),
        ('insurance_other', 'financial_other', 'Insurance', 2),
        ('investments', 'financial_other', 'Investments', 3),
        ('taxes', 'financial_other', 'Taxes', 4);

      INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order)
      SELECT category, category, CASE WHEN amount < 0 THEN 'expense' ELSE 'income' END, 1000
      FROM budget_entries
      WHERE category NOT IN (SELECT key FROM budget_categories)
      GROUP BY category;

      INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order)
      SELECT subcategory, category, subcategory, 1000
      FROM budget_entries
      WHERE subcategory != ''
        AND subcategory NOT IN (SELECT key FROM budget_subcategories)
        AND category IN (SELECT key FROM budget_categories WHERE type = 'expense')
      GROUP BY category, subcategory;
    `,
  },
  {
    version: 17,
    description: 'API tokens for non-interactive authentication',
    up: `
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

      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_created_by ON api_tokens(created_by);
    `,
  },
  {
    version: 18,
    description: 'Birthdays with calendar integration',
    up: `
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

      CREATE TRIGGER IF NOT EXISTS trg_birthdays_updated_at
        AFTER UPDATE ON birthdays FOR EACH ROW
        BEGIN UPDATE birthdays SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_birthdays_name         ON birthdays(name);
      CREATE INDEX IF NOT EXISTS idx_birthdays_birth_date   ON birthdays(birth_date);
      CREATE INDEX IF NOT EXISTS idx_birthdays_created_by   ON birthdays(created_by);
      CREATE INDEX IF NOT EXISTS idx_birthdays_calendar_ref ON birthdays(calendar_event_id);
    `,
  },
  {
    version: 19,
    description: 'Separate family member role from system access role',
    up: `
      ALTER TABLE users ADD COLUMN family_role TEXT NOT NULL DEFAULT 'other'
        CHECK(family_role IN ('dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'));

      CREATE INDEX IF NOT EXISTS idx_users_family_role ON users(family_role);
    `,
  },
  {
    version: 20,
    description: 'User profile pictures',
    up: `
      ALTER TABLE users ADD COLUMN avatar_data TEXT;
    `,
  },
  {
    version: 21,
    description: 'Calendar event icons',
    up: `
      ALTER TABLE calendar_events ADD COLUMN icon TEXT NOT NULL DEFAULT 'calendar';
    `,
  },
  {
    version: 22,
    description: 'Normalize calendar dentist icon',
    up: `
      UPDATE calendar_events SET icon = 'drill' WHERE icon = 'tooth';
    `,
  },
  {
    version: 23,
    description: 'Link family members with contacts and birthdays',
    up: `
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
  },
  {
    version: 24,
    description: 'Use tooth icon for dentist calendar events',
    up: `
      UPDATE calendar_events SET icon = 'tooth' WHERE icon = 'drill';
    `,
  },
  {
    version: 25,
    description: 'Allow archived status for tasks',
    up: `
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
  },
  {
    version: 26,
    description: 'Family documents with local storage metadata and visibility ACL',
    up: `
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
  },
  {
    version: 27,
    description: 'Calendar event attachments',
    up: `
      ALTER TABLE calendar_events ADD COLUMN attachment_name TEXT;
      ALTER TABLE calendar_events ADD COLUMN attachment_mime TEXT;
      ALTER TABLE calendar_events ADD COLUMN attachment_size INTEGER;
      ALTER TABLE calendar_events ADD COLUMN attachment_data TEXT;
    `,
  },
  {
    version: 28,
    description: 'Budget loans and installment payments',
    up: `
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
  },
  {
    version: 29,
    description: 'Generic CalDAV multi-account support',
    up: (db) => {
      // Create caldav_accounts table
      db.exec(`
        CREATE TABLE caldav_accounts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL,
          caldav_url      TEXT NOT NULL,
          username        TEXT NOT NULL,
          password        TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_sync       TEXT,
          UNIQUE(caldav_url, username)
        )
      `);

      // Create caldav_calendar_selection table
      db.exec(`
        CREATE TABLE caldav_calendar_selection (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id      INTEGER NOT NULL,
          calendar_url    TEXT NOT NULL,
          calendar_name   TEXT NOT NULL,
          calendar_color  TEXT,
          enabled         INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
          UNIQUE(account_id, calendar_url)
        )
      `);

      // Create index for performance
      db.exec(`
        CREATE INDEX idx_caldav_selection_enabled
          ON caldav_calendar_selection(account_id, enabled)
      `);

      // Update external_calendars to allow 'caldav' source
      db.exec(`
        CREATE TABLE external_calendars_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          source      TEXT    NOT NULL CHECK(source IN ('google', 'apple', 'caldav')),
          external_id TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          color       TEXT,
          UNIQUE(source, external_id)
        )
      `);

      db.exec(`
        INSERT INTO external_calendars_new (id, source, external_id, name, color)
        SELECT id, source, external_id, name, color
        FROM external_calendars
      `);

      db.exec(`DROP TABLE external_calendars`);
      db.exec(`ALTER TABLE external_calendars_new RENAME TO external_calendars`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ext_cal_source ON external_calendars(source, external_id)`);

      // Migrate existing Apple data
      const appleUrl = db.prepare("SELECT value FROM sync_config WHERE key='apple_caldav_url'").get()?.value;
      const appleUser = db.prepare("SELECT value FROM sync_config WHERE key='apple_username'").get()?.value;
      const applePwd = db.prepare("SELECT value FROM sync_config WHERE key='apple_app_password'").get()?.value;
      const appleLastSync = db.prepare("SELECT value FROM sync_config WHERE key='apple_last_sync'").get()?.value;

      if (appleUrl && appleUser && applePwd) {
        // Insert migrated Apple account
        const result = db.prepare(`
          INSERT INTO caldav_accounts (name, caldav_url, username, password, last_sync)
          VALUES (?, ?, ?, ?, ?)
        `).run('Apple Calendar (migriert)', appleUrl, appleUser, applePwd, appleLastSync);

        const accountId = result.lastInsertRowid;

        // Migrate Apple calendars from external_calendars
        const appleCalendars = db.prepare(`
          SELECT external_id, name, color FROM external_calendars WHERE source='apple'
        `).all();

        for (const cal of appleCalendars) {
          db.prepare(`
            INSERT INTO caldav_calendar_selection
              (account_id, calendar_url, calendar_name, calendar_color, enabled)
            VALUES (?, ?, ?, ?, 1)
          `).run(accountId, cal.external_id, cal.name, cal.color);
        }

        // Update external_calendars source
        db.prepare(`UPDATE external_calendars SET source='caldav' WHERE source='apple'`).run();

      }

      // Add caldav to external_source CHECK constraint by recreating table
      db.exec(`
        CREATE TABLE calendar_events_new (
          id                           INTEGER PRIMARY KEY AUTOINCREMENT,
          title                        TEXT    NOT NULL,
          description                  TEXT,
          start_datetime               TEXT    NOT NULL,
          end_datetime                 TEXT,
          all_day                      INTEGER NOT NULL DEFAULT 0,
          location                     TEXT,
          color                        TEXT    NOT NULL DEFAULT '#007AFF',
          assigned_to                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_by                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          external_calendar_id         TEXT,
          external_source              TEXT    NOT NULL DEFAULT 'local'
                                               CHECK(external_source IN ('local', 'google', 'apple', 'ics', 'caldav')),
          recurrence_rule              TEXT,
          subscription_id              INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
          user_modified                INTEGER NOT NULL DEFAULT 0,
          calendar_ref_id              INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL,
          icon                         TEXT    NOT NULL DEFAULT 'calendar',
          attachment_name              TEXT,
          attachment_mime              TEXT,
          attachment_size              INTEGER,
          attachment_data              TEXT,
          target_caldav_account_id     INTEGER,
          target_caldav_calendar_url   TEXT,
          created_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `);

      db.exec(`
        INSERT INTO calendar_events_new
          (id, title, description, start_datetime, end_datetime, all_day, location, color,
           assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
           subscription_id, user_modified, calendar_ref_id, icon,
           attachment_name, attachment_mime, attachment_size, attachment_data,
           created_at, updated_at)
        SELECT id, title, description, start_datetime, end_datetime, all_day, location, color,
               assigned_to, created_by, external_calendar_id,
               CASE WHEN external_source = 'apple' THEN 'caldav' ELSE external_source END,
               recurrence_rule, subscription_id, user_modified, calendar_ref_id, icon,
               attachment_name, attachment_mime, attachment_size, attachment_data,
               created_at, updated_at
        FROM calendar_events
      `);

      db.exec(`DROP TRIGGER IF EXISTS trg_calendar_events_updated_at`);
      db.exec(`DROP TABLE calendar_events`);
      db.exec(`ALTER TABLE calendar_events_new RENAME TO calendar_events`);

      db.exec(`
        CREATE TRIGGER trg_calendar_events_updated_at
          AFTER UPDATE ON calendar_events FOR EACH ROW
          BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_datetime)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_assigned ON calendar_events(assigned_to)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_external_id ON calendar_events(external_calendar_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_sub ON calendar_events(subscription_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_events_ref ON calendar_events(calendar_ref_id)`);
      db.exec(`CREATE UNIQUE INDEX idx_calendar_sub_extid ON calendar_events (subscription_id, external_calendar_id)`);
    },
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
    if (typeof migration.up === 'function') {
      migration.up(db);
    } else {
      db.exec(migration.up);
    }
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
    log.info(`Migration ${migration.version} applied: ${migration.description}`);
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

function getPath() {
  return DB_PATH;
}

async function backupToFile(destinationPath) {
  const database = get();
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  if (typeof database.backup === 'function') {
    await database.backup(destinationPath);
  } else {
    database.prepare('VACUUM INTO ?').run(destinationPath);
  }

  return destinationPath;
}

function validateBackupFile(sourcePath) {
  const candidate = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    applyEncryptionKey(candidate);
    assertReadable(candidate);
    const row = candidate.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (!row) {
      throw new Error('Backup file is not a valid Oikos database.');
    }
    return candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0;
  } finally {
    candidate.close();
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function restoreFromFile(sourcePath) {
  const backupVersion = validateBackupFile(sourcePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = `${DB_PATH}.pre-restore-${timestamp}`;
  let rollbackCreated = false;

  try {
    if (db) {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      db.close();
      db = null;
    }

    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    try {
      await fs.copyFile(DB_PATH, rollbackPath);
      rollbackCreated = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    await unlinkIfExists(`${DB_PATH}-wal`);
    await unlinkIfExists(`${DB_PATH}-shm`);
    await fs.copyFile(sourcePath, DB_PATH);

    init();
    log.info(`Database restored from backup. Schema v${backupVersion}${rollbackCreated ? ` | rollback: ${rollbackPath}` : ''}`);

    return {
      schemaVersion: currentVersion(),
      rollbackPath: rollbackCreated ? rollbackPath : null,
    };
  } catch (err) {
    if (rollbackCreated) {
      try {
        if (db) {
          db.close();
          db = null;
        }
        await unlinkIfExists(`${DB_PATH}-wal`);
        await unlinkIfExists(`${DB_PATH}-shm`);
        await fs.copyFile(rollbackPath, DB_PATH);
        init();
      } catch (rollbackErr) {
        log.error('Rollback after failed restore also failed:', rollbackErr);
      }
    } else if (!db) {
      try { init(); } catch { /* preserve original restore error */ }
    }
    throw err;
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
  if (!db) throw new Error('[DB] Not initialized - call init() first.');
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

export { init, get, transaction, currentVersion, getPath, backupToFile, restoreFromFile };
