/**
 * Test: reminders-Tabellen-Rebuild fuer inventory_tracked_date (Migration v141)
 * Zweck: Gleiche Gefahr wie v137 (siehe test-reminders-entity-type-migration.js) -
 *        DROP TABLE reminders muss foreignKeysOff bleiben, sonst reisst der
 *        DROP notification_deliveries mit. Zusaetzlich: inventory_item_dates
 *        muss mit korrektem Schema (FK, Trigger) entstehen.
 * Ausführen: node --test test/test-tracked-dates-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-trackeddatesmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V141 = MIGRATIONS.find((m) => m.version === 141);

function seedPreV141() {
  const db = new Database(join(tempDir('yuvomi-trackeddatesmig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    CREATE TABLE inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);

    CREATE TABLE reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item')),
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
    INSERT INTO inventory_items (name) VALUES ('Auto');
    INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at)
      VALUES ('inventory_item', 1, '2026-09-01T09:00:00Z', 0, 1, '2026-07-02T10:00:00Z', NULL);
    INSERT INTO notification_deliveries (reminder_id, provider, target_key, status, sent_at)
      VALUES (1, 'gotify', 'default', 'sent', '2026-08-01T09:00:06Z');
  `);
  return db;
}

test('v141 ist als foreignKeysOff-Migration deklariert', () => {
  assert.equal(V141.foreignKeysOff, true);
});

test('v141 erhält bestehende Erinnerungen und Zustellprotokolle', () => {
  const db = seedPreV141();
  db.pragma('foreign_keys = OFF');
  db.exec(V141.up);
  db.pragma('foreign_keys = ON');

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reminders').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notification_deliveries').get().c, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test("v141 erlaubt entity_type 'inventory_tracked_date'", () => {
  const db = seedPreV141();
  db.pragma('foreign_keys = OFF');
  db.exec(V141.up);
  db.pragma('foreign_keys = ON');

  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('inventory_tracked_date', 1, '2026-10-01T09:00:00Z', 1)").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'inventory_tracked_date'").get().c,
    1,
  );
  db.close();
});

test('v141 legt inventory_item_dates mit FK auf inventory_items und Updated-At-Trigger an', () => {
  const db = seedPreV141();
  db.pragma('foreign_keys = OFF');
  db.exec(V141.up);
  db.pragma('foreign_keys = ON');

  db.prepare("INSERT INTO inventory_item_dates (item_id, label, date) VALUES (1, 'TÜV', '2027-01-01')").run();
  const row = db.prepare('SELECT * FROM inventory_item_dates WHERE item_id = 1').get();
  assert.equal(row.label, 'TÜV');
  assert.equal(row.reminder_offset_days, 30, 'Default-Vorlauf');
  assert.ok(row.created_at && row.updated_at);

  db.prepare("UPDATE inventory_item_dates SET label = 'TÜV (verschoben)' WHERE id = ?").run(row.id);
  const updated = db.prepare('SELECT updated_at FROM inventory_item_dates WHERE id = ?').get(row.id);
  assert.ok(updated.updated_at >= row.updated_at, 'Trigger muss updated_at fortschreiben');

  assert.throws(
    () => db.prepare('INSERT INTO inventory_item_dates (item_id, label, date) VALUES (999, ?, ?)').run('X', '2027-01-01'),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test('Gegenbeweis: mit aktiver FK-Durchsetzung würde der DROP die Zustellprotokolle mitreißen', () => {
  const db = seedPreV141();
  db.pragma('foreign_keys = ON');
  db.exec(V141.up);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notification_deliveries').get().c, 0,
    'belegt, warum foreignKeysOff an v141 nicht wegfallen darf');
  db.close();
});
