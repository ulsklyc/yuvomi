/**
 * Modul: Datenbank-Test
 * Zweck: Schema-Migration mit node:sqlite (built-in) validieren.
 *        Kein Kompilieren nötig - läuft direkt mit Node 22+.
 *        Testet SQL-Korrektheit, FK-Reihenfolge, Triggers, Indizes.
 *
 * Ausführen: node test-db.js
 */

import { DatabaseSync } from 'node:sqlite';

// --------------------------------------------------------
// Migrations-SQL direkt aus db.js extrahieren
// (Nur für Tests - in Produktion läuft db.js mit better-sqlite3)
// --------------------------------------------------------
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion fehlgeschlagen');
}

// --------------------------------------------------------
// Datenbank in Memory aufbauen
// --------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

console.log('\n[DB-Test] Schema-Migration\n');

// --------------------------------------------------------
// Test 1: Migrations-Tabelle anlegen
// --------------------------------------------------------
test('schema_migrations Tabelle erstellen', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  const count = db.prepare('SELECT count(*) as n FROM schema_migrations').get();
  assert(count.n === 0, 'Tabelle sollte leer sein');
});

// --------------------------------------------------------
// Test 2: Vollständige Migration v1 ausführen
// --------------------------------------------------------
test('Migration v1 ausführen (alle Tabellen und Triggers)', () => {
  db.exec(MIGRATIONS_SQL[1]);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (1, ?)').run('Initiales Schema');
  const v = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  assert(v.v === 1, 'Version sollte 1 sein');
});

// --------------------------------------------------------
// Test 3: Alle erwarteten Tabellen vorhanden
// --------------------------------------------------------
const EXPECTED_TABLES = [
  'users', 'tasks', 'shopping_lists', 'shopping_items',
  'meals', 'meal_ingredients', 'calendar_events',
  'notes', 'contacts', 'birthdays', 'budget_entries',
  'budget_categories', 'budget_subcategories', 'api_tokens',
];

EXPECTED_TABLES.forEach((table) => {
  test(`Tabelle "${table}" existiert`, () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    assert(row, `Tabelle "${table}" nicht gefunden`);
  });
});

// --------------------------------------------------------
// Test 4: Alle updated_at-Triggers vorhanden
// --------------------------------------------------------
const EXPECTED_TRIGGERS = [
  'users',
  'tasks',
  'shopping_lists',
  'shopping_items',
  'meals',
  'meal_ingredients',
  'calendar_events',
  'notes',
  'contacts',
  'birthdays',
  'budget_entries',
].map((t) => `trg_${t}_updated_at`);

EXPECTED_TRIGGERS.forEach((trigger) => {
  test(`Trigger "${trigger}" existiert`, () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?"
    ).get(trigger);
    assert(row, `Trigger "${trigger}" nicht gefunden`);
  });
});

// --------------------------------------------------------
// Test 5: CRUD-Operationen
// --------------------------------------------------------
test('User anlegen', () => {
  const result = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('admin', 'Admin', '$2b$12$test', 'admin')
  `).run();
  assert(result.lastInsertRowid === 1, 'User-ID sollte 1 sein');
});

test('Aufgabe anlegen und lesen', () => {
  const ins = db.prepare(`
    INSERT INTO tasks (title, created_by, priority) VALUES ('Testaufgabe', 1, 'high')
  `).run();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(ins.lastInsertRowid);
  assert(task.title === 'Testaufgabe', 'Titel stimmt nicht');
  assert(task.status === 'open', 'Status sollte open sein');
  assert(task.priority === 'high', 'Priorität stimmt nicht');
});

test('Mahlzeit und Einkaufsartikel mit FK-Referenz', () => {
  // Mahlzeit zuerst (FK-Reihenfolge)
  const meal = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-03-24', 'dinner', 'Pizza', 1)
  `).run();

  const list = db.prepare(`
    INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', 1)
  `).run();

  // Artikel mit Referenz auf Mahlzeit
  db.prepare(`
    INSERT INTO shopping_items (list_id, name, added_from_meal) VALUES (?, 'Mehl', ?)
  `).run(list.lastInsertRowid, meal.lastInsertRowid);

  const item = db.prepare('SELECT * FROM shopping_items WHERE name = ?').get('Mehl');
  assert(item.added_from_meal === meal.lastInsertRowid, 'FK zu meals stimmt nicht');
});

test('updated_at Trigger feuert bei UPDATE', () => {
  const before = db.prepare('SELECT updated_at FROM tasks WHERE id = 1').get();
  // Kurz warten damit Timestamp sich unterscheidet
  const start = Date.now();
  while (Date.now() - start < 1100) { /* busy wait 1s */ }
  db.prepare("UPDATE tasks SET title = 'Geändert' WHERE id = 1").run();
  const after = db.prepare('SELECT updated_at FROM tasks WHERE id = 1').get();
  assert(after.updated_at > before.updated_at, 'updated_at sollte nach UPDATE neuer sein');
});

test('FK ON DELETE CASCADE (User löschen → Aufgaben weg)', () => {
  // Zweiten User mit Aufgabe anlegen
  db.prepare(`INSERT INTO users (username, display_name, password_hash) VALUES ('user2', 'User 2', 'x')`).run();
  db.prepare(`INSERT INTO tasks (title, created_by) VALUES ('Zu löschen', 2)`).run();

  db.prepare('DELETE FROM users WHERE id = 2').run();

  const orphan = db.prepare("SELECT * FROM tasks WHERE title = 'Zu löschen'").get();
  assert(!orphan, 'Verwaiste Aufgaben sollten gelöscht sein');
});

test('CHECK constraint: ungültige Priorität wird abgelehnt', () => {
  let threw = false;
  try {
    db.prepare("INSERT INTO tasks (title, created_by, priority) VALUES ('x', 1, 'invalid')").run();
  } catch {
    threw = true;
  }
  assert(threw, 'CHECK constraint sollte Fehler werfen');
});

test('Idempotenz: Migration zweimal ausführen ändert nichts', () => {
  // CREATE TABLE IF NOT EXISTS + CREATE TRIGGER IF NOT EXISTS müssen idempotent sein
  db.exec(MIGRATIONS_SQL[1]);
  const tables = db.prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table'").get();
  assert(tables.n > 0, 'Tabellen sollten noch vorhanden sein');
});

test('API-Token anlegen und lesen', () => {
  const result = db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, expires_at)
    VALUES ('MCP integration', 'hash-123', 'oikos_abc123', 1, '2026-12-31T23:59:59.000Z')
  `).run();
  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(result.lastInsertRowid);
  assert(token.name === 'MCP integration', 'Token name stimmt nicht');
  assert(token.created_by === 1, 'Token creator stimmt nicht');
  assert(token.revoked_at === null, 'Token sollte nicht widerrufen sein');
});

test('Migration 64 legt wiederkehrende Mahlzeiten-Struktur an', () => {
  const recurrentDb = new DatabaseSync(':memory:');
  recurrentDb.exec('PRAGMA foreign_keys = ON;');
  recurrentDb.exec(MIGRATIONS_SQL[1]);
  recurrentDb.exec(MIGRATIONS_SQL[13]);
  recurrentDb.exec(MIGRATIONS_SQL[64]);

  for (const table of ['meal_recurrence_templates', 'meal_recurrence_ingredients', 'meal_recurrence_exceptions']) {
    const row = recurrentDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    assert(row, `Tabelle "${table}" nicht gefunden`);
  }

  const recurrenceColumn = recurrentDb.prepare(`
    SELECT name FROM pragma_table_info('meals')
    WHERE name = 'recurrence_template_id'
  `).get();
  assert(recurrenceColumn, 'Spalte recurrence_template_id fehlt');

  const uniqueIndex = recurrentDb.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_meals_recurrence_occurrence'
  `).get();
  assert(uniqueIndex, 'Unique-Index für wiederkehrende Vorkommen fehlt');
  recurrentDb.close();
});

test('Geburtstag mit Kalender-Referenz anlegen', () => {
  const event = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, created_by, recurrence_rule)
    VALUES ('Birthday: Alex', '2014-05-10', 1, 1, 'FREQ=YEARLY;INTERVAL=1')
  `).run();
  const birthday = db.prepare(`
    INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by)
    VALUES ('Alex', '2014-05-10', ?, 1)
  `).run(event.lastInsertRowid);
  const row = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(birthday.lastInsertRowid);
  assert(row.calendar_event_id === event.lastInsertRowid, 'Kalender-Referenz stimmt nicht');
});

// --------------------------------------------------------
// Das CalDAV-Konto eines Termins und seines Löschauftrags (#1860)
//
// Anders als der Rest dieser Datei gegen das ECHTE Schema, also nach allen
// Migrationen von server/db.js: die Frage ist, ob die Spalten ihren
// Fremdschlüssel am Ende noch tragen. Migration 238 legt ihn an; ein späterer
// Rebuild einer der beiden Tabellen, der die Spalte ohne ihn abschreibt, fiele
// sonst erst auf, wenn ein gelöschtes Konto Termine hinterlässt, die auf
// nichts mehr zeigen.
// --------------------------------------------------------
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
const migrated = (await import('../server/db.js')).get();

for (const [table, onDelete] of [['calendar_events', 'SET NULL'], ['calendar_pending_deletions', 'CASCADE']]) {
  test(`${table}.caldav_account_id zeigt nach allen Migrationen auf caldav_accounts (ON DELETE ${onDelete})`, () => {
    const fk = migrated.pragma(`foreign_key_list(${table})`).find((row) => row.from === 'caldav_account_id');
    assert(fk, `${table}.caldav_account_id trägt keinen Fremdschlüssel`);
    assert(fk.table === 'caldav_accounts' && fk.to === 'id', `zeigt auf ${fk.table}.${fk.to}`);
    assert(fk.on_delete === onDelete, `ON DELETE ist ${fk.on_delete}, erwartet ${onDelete}`);
  });
}

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[DB-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
