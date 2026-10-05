/**
 * Test: Serien-Instanzen erben das Konto nach (Migration v181, #973)
 * Zweck: Der Code-Fix greift nur bei NEUEN Zeilen. Jeder Monat, der vor dem
 *        Update einmal geoeffnet wurde, traegt seine Instanz bereits mit
 *        account_id NULL, und die Materialisierung ueberspringt vorhandene
 *        Zeilen - der gemeldete Fehler bliebe genau fuer die Daten stehen, an
 *        denen er aufgefallen ist. Geprueft wird deshalb die Nachbesserung
 *        selbst, und vor allem ihre drei Grenzen: sie fasst kein Original an,
 *        ueberschreibt kein abweichend gesetztes Konto, und laesst virtuelle
 *        Serien in Ruhe, deren Instanzen Planwerte sind.
 * Ausfuehren: node --test test/test-budget-account-inherit-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei: db.js migriert beim Modul-Load.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-accmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V181 = MIGRATIONS.find((m) => m.version === 181);

/** Minimaler Stand von budget_entries, wie er vor v181 aussah. */
function seed() {
  const db = new Database(join(tempDir('yuvomi-accmig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE budget_entries (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      title                TEXT    NOT NULL,
      amount               REAL    NOT NULL,
      date                 TEXT    NOT NULL,
      is_recurring         INTEGER NOT NULL DEFAULT 0,
      recurrence_parent_id INTEGER,
      recurrence_virtual   INTEGER NOT NULL DEFAULT 0,
      account_id           INTEGER
    );
  `);
  const add = db.prepare(`INSERT INTO budget_entries
    (id, title, amount, date, is_recurring, recurrence_parent_id, recurrence_virtual, account_id)
    VALUES (@id, @title, @amount, @date, @is_recurring, @parent, @virtual, @account)`);
  const row = (o) => add.run({
    is_recurring: 0, parent: null, virtual: 0, account: null, amount: -100, ...o,
  });

  // 1: echte Serie mit Konto 7, zwei Instanzen ohne Konto (der Fehlerfall)
  row({ id: 1, title: 'Miete',  date: '2026-01-05', is_recurring: 1, account: 7 });
  row({ id: 2, title: 'Miete',  date: '2026-02-05', parent: 1 });
  row({ id: 3, title: 'Miete',  date: '2026-03-05', parent: 1 });
  // 4: dieselbe Serie, eine Instanz mit ABWEICHENDEM Konto - eine Entscheidung
  row({ id: 4, title: 'Miete',  date: '2026-04-05', parent: 1, account: 9 });
  // 5: Serie OHNE Konto - es gibt nichts zu erben
  row({ id: 5, title: 'Strom',  date: '2026-01-08', is_recurring: 1 });
  row({ id: 6, title: 'Strom',  date: '2026-02-08', parent: 5 });
  // 7: VIRTUELLE Serie mit Konto - ihre Instanzen sind geglaettete Planwerte
  row({ id: 7, title: 'Police', date: '2026-01-09', is_recurring: 1, virtual: 1, account: 7 });
  row({ id: 8, title: 'Police', date: '2026-02-09', parent: 7 });
  // 9: Einzelbuchung ohne Serie, ohne Konto - darf unberuehrt bleiben
  row({ id: 9, title: 'Kaffee', date: '2026-02-10' });
  return db;
}

const accountOf = (db, id) =>
  db.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(id).account_id;

test('v181 traegt das Serien-Konto an kontolosen Instanzen nach', () => {
  const db = seed();
  db.exec(V181.up);
  assert.equal(accountOf(db, 2), 7, 'Februar-Instanz erbt das Konto der Serie');
  assert.equal(accountOf(db, 3), 7, 'Maerz-Instanz ebenso');
  db.close();
});

test('v181 ueberschreibt kein abweichend gesetztes Konto', () => {
  const db = seed();
  db.exec(V181.up);
  assert.equal(accountOf(db, 4), 9,
    'ein bewusst anderes Konto an einer Instanz ist eine Entscheidung, keine Luecke');
  db.close();
});

test('v181 laesst virtuelle Serien in Ruhe', () => {
  const db = seed();
  db.exec(V181.up);
  assert.equal(accountOf(db, 8), null,
    'ein geglaetteter Planwert darf keinen Kontosaldo bewegen');
  assert.equal(accountOf(db, 7), 7, 'die virtuelle Serie selbst behaelt ihres');
  db.close();
});

test('v181 fasst weder Originale noch Einzelbuchungen an', () => {
  const db = seed();
  db.exec(V181.up);
  assert.equal(accountOf(db, 1), 7, 'das Serien-Original behaelt sein Konto');
  assert.equal(accountOf(db, 5), null, 'eine Serie ohne Konto bekommt keines angedichtet');
  assert.equal(accountOf(db, 6), null, 'ihre Instanz auch nicht - es gibt nichts zu erben');
  assert.equal(accountOf(db, 9), null, 'eine Einzelbuchung ist keine Instanz');
  db.close();
});

test('v181 ist idempotent', () => {
  // Migrationen laufen einmal, aber ein zweiter Lauf darf nichts kaputt machen -
  // und der Test kostet nichts, waehrend ein UPDATE mit Unterabfrage genau die
  // Stelle ist, an der ein zweiter Durchgang etwas anderes tun koennte.
  const db = seed();
  db.exec(V181.up);
  const nach1 = db.prepare('SELECT id, account_id FROM budget_entries ORDER BY id').all();
  db.exec(V181.up);
  const nach2 = db.prepare('SELECT id, account_id FROM budget_entries ORDER BY id').all();
  assert.deepEqual(nach2, nach1);
  db.close();
});
