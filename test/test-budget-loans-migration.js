/**
 * Test: Loans-Tabellen-Rebuild für den variablen Zinsmodus (Migration v101, #569-Nachtrag)
 * Zweck: SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher baut v101
 *        budget_loans neu auf. Diese Suite sichert die riskanten Punkte dieses
 *        Rebuilds: gekoppelte Ratenzahlungen (ON DELETE CASCADE) müssen erhalten
 *        bleiben, Trigger/Indizes müssen zurückkommen, der neue Enum-Wert muss
 *        erlaubt und Unsinn weiter abgewiesen sein. Zusätzlich der Gegenbeweis,
 *        warum `foreignKeysOff` an der Migration Pflicht ist.
 * Ausführen: node --test test/test-budget-loans-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei setzen: db.js initialisiert beim
// Modul-Load (und migriert dabei). Geprüft wird hier nur die exportierte v101-SQL
// gegen eine eigens aufgebaute Vor-v101-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-loanmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V101 = MIGRATIONS.find((m) => m.version === 101);
const V102 = MIGRATIONS.find((m) => m.version === 102);

// Stand von budget_loans direkt vor v101 (v28 + v88 + v100) mit einem Darlehen
// und einer gekoppelten Ratenzahlung.
function seedPreV101() {
  const db = new Database(join(tempDir('yuvomi-loanmig-'), 'db.sqlite'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);

    CREATE TABLE budget_loans (
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
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      visibility        TEXT    NOT NULL DEFAULT 'shared'
                                CHECK (visibility IN ('private', 'shared')),
      interest_mode     TEXT    NOT NULL DEFAULT 'none'
                                CHECK(interest_mode IN ('none', 'fixed', 'fixed_then_variable')),
      principal              REAL,
      fixed_rate             REAL,
      initial_repayment_rate REAL,
      fixed_period_months    INTEGER,
      followup_rate          REAL
    );

    CREATE TABLE budget_loan_payments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id            INTEGER NOT NULL REFERENCES budget_loans(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL CHECK(installment_number > 0),
      amount             REAL    NOT NULL CHECK(amount > 0),
      paid_date          TEXT    NOT NULL,
      created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(loan_id, installment_number)
    );

    CREATE TRIGGER trg_budget_loans_updated_at
      AFTER UPDATE ON budget_loans FOR EACH ROW
      BEGIN UPDATE budget_loans SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

    CREATE INDEX idx_budget_loans_status ON budget_loans(status);
    CREATE INDEX idx_budget_loans_start_month ON budget_loans(start_month);
    CREATE INDEX idx_budget_loans_owner ON budget_loans(owner_id);

    INSERT INTO users (username) VALUES ('a');
    INSERT INTO budget_loans
      (title, borrower, total_amount, installment_count, start_month, created_by, owner_id,
       interest_mode, principal, fixed_rate, initial_repayment_rate, fixed_period_months, followup_rate)
    VALUES
      ('Hypothek', 'Bank', 260000, 300, '2026-01', 1, 1, 'fixed_then_variable', 200000, 2.5, 2, 180, 4),
      ('Zinsfrei', 'Lais', 1200, 12, '2026-05', 1, 1, 'none', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, created_by)
      VALUES (1, 1, 750, '2026-01-01', 1), (1, 2, 750, '2026-02-01', 1), (2, 1, 100, '2026-05-01', 1);
  `);
  return db;
}

test('v101 ist als foreignKeysOff-Migration deklariert (sonst kaskadiert der DROP)', () => {
  assert.equal(V101.foreignKeysOff, true);
});

test('v101 erhält Darlehen, Ratenzahlungen, Trigger und Indizes', () => {
  const db = seedPreV101();
  // Der Migration-Runner schaltet die FK-Durchsetzung für diese Migration ab.
  db.pragma('foreign_keys = OFF');
  db.exec(V101.up);
  db.pragma('foreign_keys = ON');

  assert.deepEqual(
    db.prepare('SELECT id, title, interest_mode, principal FROM budget_loans ORDER BY id').all(),
    [
      { id: 1, title: 'Hypothek', interest_mode: 'fixed_then_variable', principal: 200000 },
      { id: 2, title: 'Zinsfrei', interest_mode: 'none', principal: null },
    ],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_loan_payments').get().c, 3,
    'Ratenzahlungen dürfen den Rebuild überleben');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'keine verwaisten Kind-Zeilen');

  const objects = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = 'budget_loans' AND type IN ('trigger', 'index') ORDER BY name",
  ).all();
  assert.deepEqual(objects, [
    { type: 'index', name: 'idx_budget_loans_owner' },
    { type: 'index', name: 'idx_budget_loans_start_month' },
    { type: 'index', name: 'idx_budget_loans_status' },
    { type: 'trigger', name: 'trg_budget_loans_updated_at' },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'budget_loans_new'").get().c, 0,
    'Hilfstabelle darf nicht zurückbleiben');
  db.close();
});

test("v101 erlaubt interest_mode 'variable' und weist Unbekanntes weiter ab", () => {
  const db = seedPreV101();
  db.pragma('foreign_keys = OFF');
  db.exec(V101.up);
  db.pragma('foreign_keys = ON');

  db.prepare("UPDATE budget_loans SET interest_mode = 'variable' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT interest_mode FROM budget_loans WHERE id = 1').get().interest_mode, 'variable');
  assert.throws(() => db.prepare("UPDATE budget_loans SET interest_mode = 'bogus' WHERE id = 1").run(),
    /CHECK constraint failed/);
  db.close();
});

test('v102 rüstet Währung + Kurs nach, ohne Altbestand umzuwerten (#582)', () => {
  const db = seedPreV101();
  db.pragma('foreign_keys = OFF');
  db.exec(V101.up);
  db.pragma('foreign_keys = ON');
  db.exec(V102.up);

  // Kritisch: bestehende Darlehen müssen currency=NULL (= Budget-Währung) und
  // Kurs 1 behalten - ein anderer Default würde jeden Altbestand umrechnen.
  assert.deepEqual(
    db.prepare('SELECT id, currency, exchange_rate FROM budget_loans ORDER BY id').all(),
    [
      { id: 1, currency: null, exchange_rate: 1 },
      { id: 2, currency: null, exchange_rate: 1 },
    ],
  );
  db.close();
});

test('Gegenbeweis: mit aktiver FK-Durchsetzung würde der DROP die Raten mitreißen', () => {
  const db = seedPreV101();
  db.pragma('foreign_keys = ON');
  db.exec(V101.up);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_loan_payments').get().c, 0,
    'belegt, warum foreignKeysOff an v101 nicht wegfallen darf');
  db.close();
});
