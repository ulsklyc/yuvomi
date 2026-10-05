/**
 * Test: Reminder-Tabellen-Rebuild für inventory_item-Entities (Migration v140, Stufe 4)
 * Zweck: SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher baut v140
 *        reminders neu auf. Der riskante Punkt ist der `DROP TABLE reminders`: seit
 *        notification_deliveries.reminder_id ... ON DELETE CASCADE existiert, würde
 *        der DROP bei aktiver FK-Durchsetzung sämtliche Zustellprotokolle jeder
 *        bestehenden Installation mitlöschen. Diese Suite sichert, dass Reminder
 *        (inkl. pushed_at) und Zustellprotokolle den Rebuild überleben - plus den
 *        Gegenbeweis, warum `foreignKeysOff` an v140 Pflicht ist.
 * Ausführen: node --test test/test-reminders-entity-type-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei setzen: db.js initialisiert beim
// Modul-Load (und migriert dabei). Geprüft wird hier nur die exportierte v140-SQL
// gegen eine eigens aufgebaute Vor-v140-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-remindermig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V140 = MIGRATIONS.find((m) => m.version === 140);

// Stand von reminders direkt vor v140 (v8 + v54 pushed_at + v57 subscription-CHECK)
// samt notification_deliveries (FK auf reminders, ON DELETE CASCADE) und je einer
// Zeile pro Tabelle.
function seedPreV140() {
  const db = new Database(join(tempDir('yuvomi-remindermig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);

    CREATE TABLE reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription')),
      entity_id   INTEGER NOT NULL,
      remind_at   TEXT    NOT NULL,
      dismissed   INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      pushed_at   TEXT
    );

    CREATE TABLE notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE notification_deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id     INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      provider        TEXT    NOT NULL,
      channel_id      INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
      target_key      TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending', 'sent', 'failed', 'skipped')),
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_attempt_at TEXT,
      sent_at         TEXT,
      error           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE(reminder_id, provider, target_key)
    );

    CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
    CREATE INDEX idx_reminders_remind ON reminders(remind_at);
    CREATE INDEX idx_reminders_user   ON reminders(created_by);
    CREATE INDEX idx_notification_deliveries_reminder ON notification_deliveries(reminder_id);

    INSERT INTO users (username) VALUES ('a');
    INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at)
      VALUES
        ('task',         7, '2026-08-01T09:00:00Z', 0, 1, '2026-07-01T10:00:00Z', '2026-08-01T09:00:05Z'),
        ('subscription', 3, '2026-09-01T09:00:00Z', 1, 1, '2026-07-02T10:00:00Z', NULL);
    INSERT INTO notification_deliveries (reminder_id, provider, target_key, status, sent_at)
      VALUES (1, 'gotify', 'default', 'sent', '2026-08-01T09:00:06Z');
  `);
  return db;
}

test('v140 ist als foreignKeysOff-Migration deklariert (sonst kaskadiert der DROP)', () => {
  assert.equal(V140.foreignKeysOff, true);
});

test('v140 erhält Reminder inklusive pushed_at, Zustellprotokolle und Indizes', () => {
  const db = seedPreV140();
  // Der Migration-Runner schaltet die FK-Durchsetzung für diese Migration ab.
  db.pragma('foreign_keys = OFF');
  db.exec(V140.up);
  db.pragma('foreign_keys = ON');

  assert.deepEqual(
    db.prepare('SELECT id, entity_type, entity_id, dismissed, created_at, pushed_at FROM reminders ORDER BY id').all(),
    [
      {
        id: 1,
        entity_type: 'task',
        entity_id: 7,
        dismissed: 0,
        created_at: '2026-07-01T10:00:00Z',
        pushed_at: '2026-08-01T09:00:05Z',
      },
      {
        id: 2,
        entity_type: 'subscription',
        entity_id: 3,
        dismissed: 1,
        created_at: '2026-07-02T10:00:00Z',
        pushed_at: null,
      },
    ],
  );

  assert.deepEqual(
    db.prepare('SELECT id, reminder_id, provider, status FROM notification_deliveries ORDER BY id').all(),
    [{ id: 1, reminder_id: 1, provider: 'gotify', status: 'sent' }],
    'Zustellprotokolle dürfen den Rebuild überleben',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'keine verwaisten Kind-Zeilen');

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE tbl_name = 'reminders' AND type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name);
  assert.deepEqual(indexes, ['idx_reminders_entity', 'idx_reminders_remind', 'idx_reminders_user']);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'reminders_new'").get().c, 0,
    'Hilfstabelle darf nicht zurückbleiben');
  db.close();
});

test("v140 erlaubt entity_type 'inventory_item' und weist Unbekanntes weiter ab", () => {
  const db = seedPreV140();
  db.pragma('foreign_keys = OFF');
  db.exec(V140.up);
  db.pragma('foreign_keys = ON');

  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('inventory_item', 42, '2026-10-01T09:00:00Z', 1)").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'inventory_item'").get().c,
    1,
  );
  assert.throws(
    () => db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('bogus', 1, '2026-10-01T09:00:00Z', 1)").run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test('Gegenbeweis: mit aktiver FK-Durchsetzung würde der DROP die Zustellprotokolle mitreißen', () => {
  const db = seedPreV140();
  db.pragma('foreign_keys = ON');
  db.exec(V140.up);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notification_deliveries').get().c, 0,
    'belegt, warum foreignKeysOff an v140 nicht wegfallen darf');
  db.close();
});
