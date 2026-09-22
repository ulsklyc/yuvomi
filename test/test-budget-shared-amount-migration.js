/**
 * Test: budget_entries-Rebuild für die dritte Sichtbarkeit (Migration v156, #659)
 * Zweck: SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher baut
 *        v156 budget_entries neu auf - und an dieser Tabelle haengen mehr
 *        Kind-Zeilen als an jeder anderen, die das Projekt bisher so umgebaut
 *        hat: Belege, Wiederholungs-Ausnahmen und Inventar-Verknuepfungen, alle
 *        drei per ON DELETE CASCADE, dazu ein Selbstbezug (recurrence_parent_id)
 *        und vier weitere Fremdschluessel.
 *
 *        Abgesichert werden die riskanten Punkte: kein Datenverlust, alle
 *        Spalten wieder da (v57 hat an genau dieser Stelle reminders.pushed_at
 *        verloren, v62 musste es nachtragen), Trigger und Indizes zurueck, der
 *        neue Enum-Wert erlaubt, Unsinn weiter abgewiesen. Dazu der Gegenbeweis,
 *        warum `foreignKeysOff` Pflicht ist.
 * Ausführen: node --test test/test-budget-shared-amount-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei setzen: db.js initialisiert beim
// Modul-Load (und migriert dabei). Geprüft wird hier nur die exportierte v156-SQL
// gegen eine eigens aufgebaute Vor-v156-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-vismig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V156 = MIGRATIONS.find((m) => m.version === 156);

/** Die 21 Spalten, die budget_entries vor v156 hat - und danach haben muss. */
const COLUMNS = [
  'id', 'title', 'amount', 'category', 'date', 'is_recurring', 'recurrence_rule',
  'created_by', 'created_at', 'updated_at', 'recurrence_parent_id', 'subcategory',
  'recurrence_interval', 'recurrence_virtual', 'recurrence_full_amount',
  'account_id', 'owner_id', 'visibility', 'recurrence_interval_count',
  'recurrence_confirm', 'is_pending',
];

/**
 * Stand von budget_entries direkt vor v156, mit je einer Zeile an jeder
 * Kind-Tabelle, die per ON DELETE CASCADE an der Buchung haengt.
 */
function seedPreV156() {
  const db = new Database(join(tempDir('yuvomi-vismig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    CREATE TABLE budget_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE family_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);

    CREATE TABLE budget_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT    NOT NULL,
      amount          REAL    NOT NULL,
      category        TEXT    NOT NULL DEFAULT 'Sonstiges',
      date            TEXT    NOT NULL,
      is_recurring    INTEGER NOT NULL DEFAULT 0,
      recurrence_rule TEXT,
      created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      recurrence_parent_id INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
      subcategory     TEXT    NOT NULL DEFAULT '',
      recurrence_interval TEXT NOT NULL DEFAULT 'monthly',
      recurrence_virtual  INTEGER NOT NULL DEFAULT 0,
      recurrence_full_amount REAL,
      account_id      INTEGER REFERENCES budget_accounts(id) ON DELETE SET NULL,
      owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      visibility      TEXT    NOT NULL DEFAULT 'shared'
                              CHECK (visibility IN ('private', 'shared')),
      recurrence_interval_count INTEGER NOT NULL DEFAULT 1,
      recurrence_confirm INTEGER NOT NULL DEFAULT 0,
      is_pending      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE budget_entry_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id    INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
      created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(entry_id, document_id)
    );
    CREATE TABLE budget_recurrence_skipped (
      parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      date      TEXT    NOT NULL,
      PRIMARY KEY (parent_id, date)
    );
    CREATE TABLE inventory_item_entries (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id  INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      role     TEXT    NOT NULL
    );
    CREATE TABLE budget_loan_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      budget_entry_id INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL
    );

    CREATE TRIGGER trg_budget_entries_updated_at
      AFTER UPDATE ON budget_entries FOR EACH ROW
      BEGIN UPDATE budget_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    CREATE INDEX idx_budget_date       ON budget_entries(date);
    CREATE INDEX idx_budget_created_by ON budget_entries(created_by);
    CREATE INDEX idx_budget_parent     ON budget_entries(recurrence_parent_id);
    CREATE INDEX idx_budget_account    ON budget_entries(account_id);
    CREATE INDEX idx_budget_owner      ON budget_entries(owner_id);
    CREATE INDEX idx_budget_pending    ON budget_entries(is_pending) WHERE is_pending = 1;

    INSERT INTO users (username) VALUES ('a'), ('b');
    INSERT INTO budget_accounts (name) VALUES ('Giro');
    INSERT INTO family_documents (name) VALUES ('Beleg');
    INSERT INTO inventory_items (name) VALUES ('Spielkonsole');

    -- Serien-Elternzeile, materialisierte Instanz (Selbstbezug) und eine
    -- private Einzelbuchung mit Beleg und Inventar-Verknuepfung.
    INSERT INTO budget_entries
      (id, title, amount, category, date, is_recurring, created_by, owner_id, visibility, account_id, recurrence_parent_id)
    VALUES
      (1, 'Miete',  -800, 'housing', '2026-08-01', 1, 1, 1, 'shared',  1, NULL),
      (2, 'Miete',  -800, 'housing', '2026-09-01', 0, 1, 1, 'shared',  1, 1),
      (3, 'Skin',    -25, 'leisure', '2026-08-14', 0, 1, 1, 'private', 1, NULL);

    INSERT INTO budget_entry_attachments (entry_id, document_id, created_by) VALUES (3, 1, 1);
    INSERT INTO budget_recurrence_skipped (parent_id, date) VALUES (1, '2026-10-01');
    INSERT INTO inventory_item_entries (item_id, entry_id, role) VALUES (1, 3, 'purchase');
    INSERT INTO budget_loan_payments (budget_entry_id) VALUES (2);
  `);
  return db;
}

/** Wendet v156 so an, wie der Migration-Runner es tut. */
function applyV156(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(V156.up);
  db.pragma('foreign_keys = ON');
}

test('v156 ist als foreignKeysOff-Migration deklariert (sonst kaskadiert der DROP)', () => {
  assert.equal(V156.foreignKeysOff, true);
});

test('v156 erhaelt Buchungen, Belege, Ausnahmen und Inventar-Verknuepfungen', () => {
  const db = seedPreV156();
  applyV156(db);

  assert.deepEqual(
    db.prepare('SELECT id, title, amount, visibility, recurrence_parent_id FROM budget_entries ORDER BY id').all(),
    [
      { id: 1, title: 'Miete', amount: -800, visibility: 'shared',  recurrence_parent_id: null },
      { id: 2, title: 'Miete', amount: -800, visibility: 'shared',  recurrence_parent_id: 1 },
      { id: 3, title: 'Skin',  amount: -25,  visibility: 'private', recurrence_parent_id: null },
    ],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_entry_attachments').get().c, 1,
    'Belege duerfen den Rebuild ueberleben');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_recurrence_skipped').get().c, 1,
    'Wiederholungs-Ausnahmen duerfen den Rebuild ueberleben');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries').get().c, 1,
    'Inventar-Verknuepfungen duerfen den Rebuild ueberleben');
  assert.equal(db.prepare('SELECT budget_entry_id FROM budget_loan_payments').get().budget_entry_id, 2,
    'die Ratenzahlung zeigt weiter auf ihre Buchung');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'keine verwaisten Kind-Zeilen');
  db.close();
});

test('v156 laesst keine Spalte fallen (die Falle, in die v57 gelaufen ist)', () => {
  const db = seedPreV156();
  applyV156(db);
  assert.deepEqual(
    db.prepare('PRAGMA table_info(budget_entries)').all().map((c) => c.name).sort(),
    [...COLUMNS].sort(),
  );
  db.close();
});

test('v156 stellt Trigger und alle sechs Indizes wieder her', () => {
  const db = seedPreV156();
  applyV156(db);

  assert.deepEqual(
    db.prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'budget_entries' AND type IN ('trigger', 'index') ORDER BY name",
    ).all(),
    [
      { type: 'index', name: 'idx_budget_account' },
      { type: 'index', name: 'idx_budget_created_by' },
      { type: 'index', name: 'idx_budget_date' },
      { type: 'index', name: 'idx_budget_owner' },
      { type: 'index', name: 'idx_budget_parent' },
      { type: 'index', name: 'idx_budget_pending' },
      { type: 'trigger', name: 'trg_budget_entries_updated_at' },
    ],
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'budget_entries_new'").get().c, 0,
    'Hilfstabelle darf nicht zurueckbleiben');
  db.close();
});

test('v156 erhaelt den Selbstbezug: die Serieninstanz zeigt auf ihre neue Elternzeile', () => {
  const db = seedPreV156();
  applyV156(db);

  // Der Rebuild schreibt REFERENCES budget_entries(id) - vor dem RENAME zeigt
  // das auf die alte Tabelle. Zeigte es danach ins Leere, waere der CASCADE
  // still tot und die Instanz ueberlebte das Loeschen ihrer Serie.
  const selfRef = db.prepare('PRAGMA foreign_key_list(budget_entries)').all()
    .find((fk) => fk.from === 'recurrence_parent_id');
  assert.ok(selfRef, 'recurrence_parent_id braucht weiter einen Fremdschluessel');
  assert.equal(selfRef.table, 'budget_entries');

  db.prepare('DELETE FROM budget_entries WHERE id = 1').run();
  assert.equal(db.prepare('SELECT recurrence_parent_id FROM budget_entries WHERE id = 2').get().recurrence_parent_id,
    null, 'ON DELETE SET NULL muss weiter greifen');
  db.close();
});

test('v156 erhaelt die CASCADE-Wirkung der Kind-Tabellen', () => {
  const db = seedPreV156();
  applyV156(db);

  db.prepare('DELETE FROM budget_entries WHERE id = 3').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_entry_attachments').get().c, 0,
    'Beleg-Verknuepfung muss mit der Buchung gehen');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries').get().c, 0,
    'Inventar-Verknuepfung muss mit der Buchung gehen');
  db.close();
});

test("v156 erlaubt 'shared_amount' und weist Unbekanntes weiter ab", () => {
  const db = seedPreV156();
  applyV156(db);

  db.prepare("UPDATE budget_entries SET visibility = 'shared_amount' WHERE id = 3").run();
  assert.equal(db.prepare('SELECT visibility FROM budget_entries WHERE id = 3').get().visibility, 'shared_amount');
  assert.throws(() => db.prepare("UPDATE budget_entries SET visibility = 'public' WHERE id = 3").run(),
    /CHECK constraint failed/);
  db.close();
});

test('v156 aendert keine bestehende Sichtbarkeit (Bestand verhaelt sich unveraendert)', () => {
  const db = seedPreV156();
  const before = db.prepare('SELECT id, visibility FROM budget_entries ORDER BY id').all();
  applyV156(db);
  assert.deepEqual(db.prepare('SELECT id, visibility FROM budget_entries ORDER BY id').all(), before);
  db.close();
});

test('Gegenprobe: mit aktiver FK-Durchsetzung wuerde der DROP die Kind-Zeilen mitnehmen', () => {
  // Beweist, warum foreignKeysOff an der Migration steht. Laeuft bewusst OHNE
  // das Pragma - ein gruener Test oben ist ohne diesen hier nicht aussagekraeftig,
  // weil er auch dann gruen waere, wenn das Flag gar nichts bewirkte.
  const db = seedPreV156();
  db.pragma('foreign_keys = ON');
  db.exec(V156.up);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_entry_attachments').get().c, 0,
    'ohne foreignKeysOff sind die Belege weg - genau der Datenverlust, den das Flag verhindert');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries').get().c, 0,
    'ohne foreignKeysOff sind auch die Inventar-Verknuepfungen weg');
  db.close();
});
