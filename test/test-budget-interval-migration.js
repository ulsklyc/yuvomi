/**
 * Test: Budget-Intervalle werden Einheit + Anzahl (Migration v128, #636)
 * Zweck: Die Migration fasst zwei Umbauten an Bestandsdaten an, und beide sind
 *        still, wenn sie schiefgehen: `half_year` wird zu monatlich x 6, und die
 *        Skip-Vermerke wandern vom Monat auf den Fälligkeitstag. Ein falsch
 *        gerechneter Tag hiesse, dass eine bewusst geloeschte Buchung beim
 *        naechsten Monatsaufruf wieder auftaucht - oder eine erwartete ausbleibt.
 *        Geprüft wird deshalb der Rhythmus (gleicher Abstand wie vorher), die
 *        Kappung am Monatsende und dass verwaiste Vermerke nicht mitreisen.
 * Ausführen: node --test test/test-budget-interval-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei: db.js migriert beim Modul-Load.
// Geprüft wird hier nur die exportierte v128-SQL gegen eine eigens gebaute Vor-v128-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-intervalmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V128 = MIGRATIONS.find((m) => m.version === 128);

/** Stand von budget_entries + budget_recurrence_skipped direkt vor v128. */
function seedPreV128() {
  const db = new Database(join(tempDir('yuvomi-intervalmig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);

    CREATE TABLE budget_entries (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      title                  TEXT    NOT NULL,
      amount                 REAL    NOT NULL,
      category               TEXT    NOT NULL DEFAULT 'misc',
      subcategory            TEXT    NOT NULL DEFAULT '',
      date                   TEXT    NOT NULL,
      is_recurring           INTEGER NOT NULL DEFAULT 0,
      recurrence_rule        TEXT,
      recurrence_parent_id   INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
      recurrence_interval    TEXT    NOT NULL DEFAULT 'monthly',
      recurrence_virtual     INTEGER NOT NULL DEFAULT 0,
      recurrence_full_amount REAL,
      created_by             INTEGER NOT NULL
    );

    CREATE TABLE budget_recurrence_skipped (
      parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      month     TEXT    NOT NULL,
      PRIMARY KEY (parent_id, month)
    );

    INSERT INTO users (username) VALUES ('admin');
  `);
  return db;
}

function insertSeries(db, { title, date, interval }) {
  return db.prepare(`
    INSERT INTO budget_entries (title, amount, date, is_recurring, recurrence_interval, created_by)
    VALUES (?, -100, ?, 1, ?, 1)
  `).run(title, date, interval).lastInsertRowid;
}

function runV128(db) {
  db.exec(V128.up);
}

test('v128 existiert und ist die reine SQL-Form', () => {
  assert.ok(V128, 'Migration 128 fehlt');
  assert.equal(typeof V128.up, 'string');
});

test('half_year wird zu monatlich x 6, der Rhythmus bleibt derselbe', () => {
  const db = seedPreV128();
  const half = insertSeries(db, { title: 'Versicherung', date: '2026-01-10', interval: 'half_year' });
  const monthly = insertSeries(db, { title: 'Miete', date: '2026-01-05', interval: 'monthly' });
  const yearly = insertSeries(db, { title: 'Domain', date: '2026-01-20', interval: 'yearly' });

  runV128(db);

  const row = (id) => db.prepare(
    'SELECT recurrence_interval AS unit, recurrence_interval_count AS n FROM budget_entries WHERE id = ?'
  ).get(id);
  assert.deepEqual(row(half), { unit: 'monthly', n: 6 }, 'halbjährlich = alle 6 Monate');
  assert.deepEqual(row(monthly), { unit: 'monthly', n: 1 }, 'monatlich bleibt unangetastet');
  assert.deepEqual(row(yearly), { unit: 'yearly', n: 1 }, 'jährlich bleibt unangetastet');

  const leftovers = db.prepare(
    "SELECT COUNT(*) AS c FROM budget_entries WHERE recurrence_interval = 'half_year'"
  ).get().c;
  assert.equal(leftovers, 0, 'kein half_year mehr im Bestand');
});

test('Skip-Vermerke wandern vom Monat auf den Fälligkeitstag der Serie', () => {
  const db = seedPreV128();
  const pid = insertSeries(db, { title: 'Strom', date: '2026-01-15', interval: 'monthly' });
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)').run(pid, '2026-03');
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)').run(pid, '2026-07');

  runV128(db);

  const dates = db.prepare(
    'SELECT date FROM budget_recurrence_skipped WHERE parent_id = ? ORDER BY date'
  ).all(pid).map((r) => r.date);
  assert.deepEqual(dates, ['2026-03-15', '2026-07-15']);
});

test('Ein Starttag am Monatsende wird auf den letzten Tag des Monats gekappt', () => {
  // Die Instanz waere am 28. entstanden, nicht am 31.: der Vermerk muss auf
  // denselben Tag zeigen, sonst kaeme die geloeschte Buchung zurueck.
  const db = seedPreV128();
  const pid = insertSeries(db, { title: 'Abo', date: '2026-01-31', interval: 'monthly' });
  for (const month of ['2026-02', '2026-04', '2026-05']) {
    db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)').run(pid, month);
  }

  runV128(db);

  const dates = db.prepare(
    'SELECT date FROM budget_recurrence_skipped WHERE parent_id = ? ORDER BY date'
  ).all(pid).map((r) => r.date);
  assert.deepEqual(dates, ['2026-02-28', '2026-04-30', '2026-05-31']);
});

test('Verwaiste Vermerke ohne Serie reisen nicht mit', () => {
  const db = seedPreV128();
  const pid = insertSeries(db, { title: 'Weg', date: '2026-01-15', interval: 'monthly' });
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)').run(pid, '2026-03');
  // Ohne aktive Fremdschlüssel bleibt der Vermerk stehen, wenn die Serie verschwindet.
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(pid);

  runV128(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_recurrence_skipped').get().c, 0);
});

test('Die neue Tabelle behält Primärschlüssel und Kaskade', () => {
  const db = seedPreV128();
  const pid = insertSeries(db, { title: 'Strom', date: '2026-01-15', interval: 'monthly' });
  runV128(db);
  db.pragma('foreign_keys = ON');

  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)').run(pid, '2026-03-15');
  assert.throws(
    () => db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)').run(pid, '2026-03-15'),
    /UNIQUE|PRIMARY/,
    'derselbe Tag darf nur einmal vermerkt sein',
  );

  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(pid);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM budget_recurrence_skipped').get().c, 0,
    'Vermerke verschwinden mit ihrer Serie',
  );
});
