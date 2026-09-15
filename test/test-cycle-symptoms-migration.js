/**
 * Test: cycle_day_log_symptoms-Backfill (Migration v176)
 * Zweck: Die alte Komma-Spalte (cycle_day_logs.symptoms) wird beim Aufbau der
 *        neuen, normalisierten Tabelle rückwirkend zerlegt - eine Zeile je
 *        Symptom, ohne Intensität (die gab es vorher nicht), dedupliziert,
 *        leere/NULL-Werte erzeugen keine Geisterzeilen.
 * Ausführen: node --test test/test-cycle-symptoms-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-cyclesymptomsmig-')), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V178 = MIGRATIONS.find((m) => m.version === 178);

function seedPreV178() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-cyclesymptomsmig-')), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    CREATE TABLE cycle_day_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_date   TEXT    NOT NULL,
      flow       TEXT,
      symptoms   TEXT,
      mood       TEXT,
      note       TEXT,
      visibility TEXT    NOT NULL DEFAULT 'private',
      UNIQUE(user_id, log_date)
    );
    INSERT INTO users (username) VALUES ('a');
    INSERT INTO cycle_day_logs (user_id, log_date, symptoms) VALUES (1, '2026-06-01', 'cramps,headache');
    -- Ein Duplikat in der alten Liste selbst darf keine zwei Zeilen ergeben.
    INSERT INTO cycle_day_logs (user_id, log_date, symptoms) VALUES (1, '2026-06-02', 'cramps,cramps,bloating');
    -- NULL und leerer String duerfen keine Geisterzeile erzeugen.
    INSERT INTO cycle_day_logs (user_id, log_date, symptoms) VALUES (1, '2026-06-03', NULL);
    INSERT INTO cycle_day_logs (user_id, log_date, symptoms) VALUES (1, '2026-06-04', '');
  `);
  return db;
}

function applied() {
  const db = seedPreV178();
  V178.up(db);
  return db;
}

test('v176 legt cycle_day_log_symptoms mit den erwarteten Spalten an', () => {
  const db = applied();
  const cols = db.prepare('PRAGMA table_info(cycle_day_log_symptoms)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['day_log_id', 'id', 'intensity', 'symptom_key'].sort());
  db.close();
});

test('v176 zerlegt die Komma-Liste in einzelne Zeilen, ohne Intensitaet', () => {
  const db = applied();
  const rows = db.prepare(
    "SELECT symptom_key, intensity FROM cycle_day_log_symptoms WHERE day_log_id = 1 ORDER BY symptom_key"
  ).all();
  assert.deepEqual(rows, [
    { symptom_key: 'cramps', intensity: null },
    { symptom_key: 'headache', intensity: null },
  ]);
  db.close();
});

test('v176 dedupliziert ein Symptom, das in der alten Liste doppelt stand', () => {
  const db = applied();
  const rows = db.prepare(
    "SELECT symptom_key FROM cycle_day_log_symptoms WHERE day_log_id = 2 ORDER BY symptom_key"
  ).all().map((r) => r.symptom_key);
  assert.deepEqual(rows, ['bloating', 'cramps']);
  db.close();
});

test('v176 erzeugt keine Zeile fuer NULL oder leere Symptom-Spalten', () => {
  const db = applied();
  const countFor = (id) => db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_symptoms WHERE day_log_id = ?').get(id).c;
  assert.equal(countFor(3), 0);
  assert.equal(countFor(4), 0);
  db.close();
});

test('v176 laesst die alte Komma-Spalte unveraendert stehen (kein Rebuild, keine Loeschung)', () => {
  const db = applied();
  const rows = db.prepare('SELECT log_date, symptoms FROM cycle_day_logs ORDER BY log_date').all();
  assert.deepEqual(rows, [
    { log_date: '2026-06-01', symptoms: 'cramps,headache' },
    { log_date: '2026-06-02', symptoms: 'cramps,cramps,bloating' },
    { log_date: '2026-06-03', symptoms: null },
    { log_date: '2026-06-04', symptoms: '' },
  ]);
  db.close();
});

test('v176 legt einen Index auf day_log_id an', () => {
  const db = applied();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cycle_day_log_symptoms'").all().map((r) => r.name);
  assert.ok(names.includes('idx_cycle_day_log_symptoms_day_log'));
  db.close();
});

test('cycle_day_log_symptoms.intensity lehnt Werte ausserhalb 1-3 ab', () => {
  const db = applied();
  assert.throws(
    () => db.prepare('INSERT INTO cycle_day_log_symptoms (day_log_id, symptom_key, intensity) VALUES (1, ?, 4)').run('nausea'),
    /CHECK constraint failed/,
  );
  db.prepare('INSERT INTO cycle_day_log_symptoms (day_log_id, symptom_key, intensity) VALUES (1, ?, 3)').run('nausea');
  assert.equal(db.prepare("SELECT intensity FROM cycle_day_log_symptoms WHERE symptom_key = 'nausea'").get().intensity, 3);
  db.close();
});

test('cycle_day_log_symptoms hat UNIQUE(day_log_id, symptom_key)', () => {
  const db = applied();
  assert.throws(
    () => db.prepare("INSERT INTO cycle_day_log_symptoms (day_log_id, symptom_key, intensity) VALUES (1, 'cramps', NULL)").run(),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test('cycle_day_log_symptoms kaskadiert beim Loeschen des Tages-Logs', () => {
  const db = applied();
  db.pragma('foreign_keys = ON');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_symptoms WHERE day_log_id = 1').get().c, 2);
  db.prepare('DELETE FROM cycle_day_logs WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_symptoms WHERE day_log_id = 1').get().c, 0);
  db.close();
});

// --------------------------------------------------------------------------
// Migration v211: cycle_day_log_feelings-Backfill aus der alten mood-Spalte
// --------------------------------------------------------------------------

const V211 = MIGRATIONS.find((m) => m.version === 211);

function seedPreV211() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-cyclefeelingsmig-')), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    CREATE TABLE cycle_day_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_date   TEXT    NOT NULL,
      flow       TEXT,
      symptoms   TEXT,
      mood       TEXT,
      note       TEXT,
      visibility TEXT    NOT NULL DEFAULT 'private',
      UNIQUE(user_id, log_date)
    );
    INSERT INTO users (username) VALUES ('a');
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-01', 'good');
    -- Fuehrende/nachfolgende Leerzeichen duerfen nicht mit uebernommen werden.
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-02', '  irritable  ');
    -- NULL und leerer String duerfen keine Geisterzeile erzeugen.
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-03', NULL);
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-04', '');
    -- Gemischte Gross-/Kleinschreibung wird uebernommen, aber normalisiert.
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-05', 'Good');
    -- Ausserhalb der sieben Feelings-Schluessel: bleibt nur in mood stehen.
    INSERT INTO cycle_day_logs (user_id, log_date, mood) VALUES (1, '2030-01-06', 'tired');
  `);
  return db;
}

function appliedV211() {
  const db = seedPreV211();
  // Anders als V178 ist v211s `up` reines SQL (kein Funktions-up) - die
  // Zerlegung passiert hier nicht zeilenweise in JS, sondern per SQL-INSERT
  // ... SELECT, siehe Migration 211 in server/db.js.
  db.exec(V211.up);
  return db;
}

test('v211 legt cycle_day_log_feelings mit den erwarteten Spalten an', () => {
  const db = appliedV211();
  const cols = db.prepare('PRAGMA table_info(cycle_day_log_feelings)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['day_log_id', 'feeling_key', 'id'].sort());
  db.close();
});

test('v211 befuellt genau eine Zeile je Tages-Log mit gesetztem, gueltigem mood-Wert', () => {
  const db = appliedV211();
  const rows = db.prepare(
    'SELECT day_log_id, feeling_key FROM cycle_day_log_feelings ORDER BY day_log_id'
  ).all();
  assert.deepEqual(rows, [
    { day_log_id: 1, feeling_key: 'good' },
    { day_log_id: 2, feeling_key: 'irritable' },
    { day_log_id: 5, feeling_key: 'good' },
  ]);
  db.close();
});

test('v211 erzeugt keine Zeile fuer NULL oder leere mood-Spalten', () => {
  const db = appliedV211();
  const countFor = (id) => db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_feelings WHERE day_log_id = ?').get(id).c;
  assert.equal(countFor(3), 0);
  assert.equal(countFor(4), 0);
  db.close();
});

test('v211 normalisiert Gross-/Kleinschreibung beim Backfill ("Good" -> "good")', () => {
  const db = appliedV211();
  const row = db.prepare('SELECT feeling_key FROM cycle_day_log_feelings WHERE day_log_id = 5').get();
  assert.equal(row.feeling_key, 'good');
  db.close();
});

test('v211 uebernimmt keinen Wert ausserhalb der sieben Feelings-Schluessel ("tired" bleibt nur in mood)', () => {
  const db = appliedV211();
  const countFor6 = db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_feelings WHERE day_log_id = 6').get().c;
  assert.equal(countFor6, 0, '"tired" ist kein Feelings-Schluessel und darf keine Zeile erzeugen');
  const mood = db.prepare('SELECT mood FROM cycle_day_logs WHERE id = 6').get().mood;
  assert.equal(mood, 'tired', 'die alte mood-Spalte bleibt unangetastet, auch fuer nicht uebernommene Werte');
  db.close();
});

test('v211 laesst die alte mood-Spalte unveraendert stehen (kein Rebuild, keine Loeschung)', () => {
  const db = appliedV211();
  const rows = db.prepare('SELECT log_date, mood FROM cycle_day_logs ORDER BY log_date').all();
  assert.deepEqual(rows, [
    { log_date: '2030-01-01', mood: 'good' },
    { log_date: '2030-01-02', mood: '  irritable  ' },
    { log_date: '2030-01-03', mood: null },
    { log_date: '2030-01-04', mood: '' },
    { log_date: '2030-01-05', mood: 'Good' },
    { log_date: '2030-01-06', mood: 'tired' },
  ]);
  db.close();
});

test('v211 legt einen Index auf day_log_id an', () => {
  const db = appliedV211();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cycle_day_log_feelings'").all().map((r) => r.name);
  assert.ok(names.includes('idx_cycle_day_log_feelings_day_log'));
  db.close();
});

test('cycle_day_log_feelings hat UNIQUE(day_log_id, feeling_key)', () => {
  const db = appliedV211();
  assert.throws(
    () => db.prepare("INSERT INTO cycle_day_log_feelings (day_log_id, feeling_key) VALUES (1, 'good')").run(),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test('cycle_day_log_feelings kaskadiert beim Loeschen des Tages-Logs', () => {
  const db = appliedV211();
  db.pragma('foreign_keys = ON');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_feelings WHERE day_log_id = 1').get().c, 1);
  db.prepare('DELETE FROM cycle_day_logs WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM cycle_day_log_feelings WHERE day_log_id = 1').get().c, 0);
  db.close();
});
