/**
 * Test: reminders-Tabellen-Rebuild fuer pantry_item (Migration v162)
 * Zweck: Dieselbe Gefahr wie v137 und v141 - `DROP TABLE reminders` reisst
 *        notification_deliveries mit, wenn die Migration die Fremdschluessel
 *        nicht abschaltet. Zweimal dokumentiert, einmal passiert.
 *
 *        DESHALB STEHT HIER AUCH EINE REGEL statt nur eines dritten Einzelfalls:
 *        jede Migration, die diese Tabelle neu baut, muss `foreignKeysOff`
 *        tragen - auch die vierte, die noch niemand geschrieben hat. Eine
 *        Allowlist haette den naechsten Fall wieder nicht gesehen.
 * Ausführen: node --test test/test-pantry-reminders-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-pantrymig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V162 = MIGRATIONS.find((m) => m.version === 162);

function seedPreV162() {
  const db = new Database(join(tempDir('yuvomi-pantrymig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    CREATE TABLE pantry_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);

    CREATE TABLE reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date')),
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
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id   INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      provider      TEXT    NOT NULL,
      channel_id    INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
      target_key    TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      sent_at       TEXT,
      UNIQUE(reminder_id, provider, target_key)
    );

    CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
    CREATE INDEX idx_reminders_remind ON reminders(remind_at);
    CREATE INDEX idx_reminders_user   ON reminders(created_by);

    INSERT INTO users (username) VALUES ('a');
    INSERT INTO pantry_items (name) VALUES ('Joghurt');
    INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at)
      VALUES ('inventory_item', 1, '2026-09-01T09:00:00Z', 0, 1, '2026-07-02T10:00:00Z', NULL);
    INSERT INTO notification_deliveries (reminder_id, provider, target_key, status, sent_at)
      VALUES (1, 'gotify', 'default', 'sent', '2026-08-01T09:00:06Z');
  `);
  return db;
}

function applied() {
  const db = seedPreV162();
  db.pragma('foreign_keys = OFF');
  db.exec(V162.up);
  db.pragma('foreign_keys = ON');
  return db;
}

// DIE REGEL, nicht der Einzelfall: `reminders` wird bei jeder Erweiterung von
// entity_type neu gebaut, weil SQLite einen Spalten-CHECK nicht per ALTER
// erweitern kann. Jede dieser Migrationen braucht foreignKeysOff - sonst laufen
// die Zustellprotokolle beim DROP leer, und zwar still.
//
// DIE GRENZE IST HERGELEITET, NICHT GELISTET: v57 baute die Tabelle ebenfalls
// neu und trägt kein foreignKeysOff - zu Recht, denn der erste Fremdschlüssel
// auf `reminders` entstand erst in einer späteren Migration. Statt v57 als
// Ausnahme einzutragen (eine Zeile, die niemand mehr prüft), sucht der Guard
// selbst, ab wann die Gefahr existiert. Eine künftige Tabelle mit einem FK auf
// reminders verschiebt die Grenze automatisch mit.
test('jede Migration, die reminders neu baut, schaltet die Fremdschluessel ab', () => {
  const firstFk = MIGRATIONS.find((m) => /REFERENCES\s+reminders\s*\(/i.test(m.up || ''));
  assert.ok(firstFk, 'Keine Migration legt mehr einen Fremdschluessel auf reminders an - der Guard misst ins Leere.');

  const rebuilds = MIGRATIONS.filter((m) => /DROP TABLE reminders\b/.test(m.up || ''));
  const atRisk = rebuilds.filter((m) => m.version > firstFk.version);
  assert.ok(atRisk.length >= 3,
    `Nur ${atRisk.length} gefaehrdete Rebuild-Migrationen gefunden - das Muster greift nicht mehr, der Guard ist blind.`);

  const unguarded = atRisk.filter((m) => m.foreignKeysOff !== true).map((m) => m.version);
  assert.deepEqual(unguarded, [],
    'Ohne foreignKeysOff reisst DROP TABLE reminders die notification_deliveries mit.');
});

test('v162 erhält bestehende Erinnerungen und Zustellprotokolle', () => {
  const db = applied();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reminders').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notification_deliveries').get().c, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test("v162 erlaubt entity_type 'pantry_item'", () => {
  const db = applied();
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', 1, '2026-10-01T09:00:00Z', 1)").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item'").get().c, 1);
  db.close();
});

test('v162 laesst keinen erfundenen entity_type durch', () => {
  const db = applied();
  // Der CHECK ist die einzige Stelle, an der ein Tippfehler im Router auffliegt:
  // ohne ihn landete 'pantry' oder 'pantryItem' klaglos in der Tabelle und
  // meldete nie etwas.
  assert.throws(
    () => db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry', 1, '2026-10-01T09:00:00Z', 1)").run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test('v162 legt die drei Indizes wieder an', () => {
  const db = applied();
  // Sie haengen an der alten Tabelle und verschwinden mit ihr. Ohne sie liest
  // der Push-Lauf (WHERE remind_at <= ?) die ganze Tabelle.
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'").all().map((r) => r.name);
  for (const idx of ['idx_reminders_entity', 'idx_reminders_remind', 'idx_reminders_user']) {
    assert.ok(names.includes(idx), `${idx} fehlt nach dem Rebuild`);
  }
  db.close();
});
