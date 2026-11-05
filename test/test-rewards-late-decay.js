/**
 * Modul: Spaetabzug-Test (Late-Completion-Decay)
 * Zweck: awardForCompletion mit aktiviertem/deaktiviertem tasks_late_decay_enabled -
 *        Dekrement pro Ueberfaelligkeitstag, Untergrenze 1, Audit-Spalten,
 *        Storno-Kompatibilitaet, Datum-Grenzfaelle.
 * Ausführen: node --experimental-sqlite --test test/test-rewards-late-decay.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, _setTestDatabase } from '../server/db.js';
import { awardForCompletion, reverseTaskEarnings, getBalance } from '../server/services/rewards.js';

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const admin = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mom', 'Mama', 'x', 'admin')").run().lastInsertRowid;
const kid = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('lea', 'Lea', 'x', 'member')").run().lastInsertRowid;
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);

function setDecay(on) {
  db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('tasks_late_decay_enabled', on ? '1' : '0');
}

let taskSeq = 0;
function makeTask({ points, dueDate }) {
  const id = db.prepare("INSERT INTO tasks (title, status, created_by, points, due_date) VALUES (?, 'open', ?, ?, ?)")
    .run(`Chore ${++taskSeq}`, admin, points, dueDate).lastInsertRowid;
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, kid);
  return id;
}

// Erledigung an einem festen Wallclock-Tag (Zone UTC, Default ohne Settings).
const DONE_ON = (day) => new Date(`2026-10-${day}T12:00:00Z`);

function earnRows(taskId) {
  return db.prepare("SELECT delta, decay_days, base_points FROM reward_ledger WHERE task_id = ? AND type = 'earn'").all(taskId);
}

// ----------------------------------------------------------
// Schema
// ----------------------------------------------------------
test('Migration 282: reward_ledger hat decay_days und base_points', () => {
  const cols = db.prepare('PRAGMA table_info(reward_ledger)').all().map((c) => c.name);
  assert.ok(cols.includes('decay_days'));
  assert.ok(cols.includes('base_points'));
});

// ----------------------------------------------------------
// Aus (Standard): keine Verhaltensaenderung
// ----------------------------------------------------------
test('Setting aus: spaete Erledigung bucht volle Punkte, Audit-Spalten NULL', () => {
  setDecay(false);
  const id = makeTask({ points: 5, dueDate: '2026-10-07' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const rows = earnRows(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, 5);
  assert.equal(rows[0].decay_days, null);
  assert.equal(rows[0].base_points, null);
});

// ----------------------------------------------------------
// An: Dekrement pro Tag, Grenze 1
// ----------------------------------------------------------
test('Setting an: 3 Tage ueberfaellig, 5 Punkte -> 2 Punkte, Audit gesetzt', () => {
  setDecay(true);
  const id = makeTask({ points: 5, dueDate: '2026-10-07' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 2);
  assert.equal(row.decay_days, 3);
  assert.equal(row.base_points, 5);
});

test('Setting an: Untergrenze 1 Punkt (10 Tage ueberfaellig, 4 Punkte)', () => {
  const id = makeTask({ points: 4, dueDate: '2026-09-30' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 1);
  assert.equal(row.decay_days, 10);
  assert.equal(row.base_points, 4);
});

test('Setting an: 1-Punkt-Aufgabe 3 Tage spaeter -> 1 Punkt, Audit-Spalten bleiben NULL', () => {
  // Review #2413, Punkt 1: die Untergrenze war kein Abzug - wer 1 Punkt wert
  // ist, konnte nie underpayt werden. Ein durchgestrichener Grundwert und ein
  // "3 Tage spaeter" an der Zeile erzaehlen eine Reduktion, die nicht fand.
  setDecay(true);
  const id = makeTask({ points: 1, dueDate: '2026-10-07' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 1, 'Punkt bleibt - wie vor dem Feature');
  assert.equal(row.decay_days, null, 'kein echter Abzug, kein Grund fuer Tage');
  assert.equal(row.base_points, null, 'kein Grundwert, den man durchstreichen koennte');
});

test('Ueberfaelligkeit zaehlt im Kalendertag der Haushalt-Zeitzone', () => {
  // Review #2413, Punkt 5: 12:30 UTC ist in Auckland langst der naechste Tag -
  // der Abzug darf nicht am UTC-Kalender haengen.
  setDecay(true);
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Pacific/Auckland') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  try {
    const id = makeTask({ points: 5, dueDate: '2026-10-09' });
    awardForCompletion(db, id, admin, kid, { now: new Date('2026-10-09T12:30:00Z') });
    const [row] = earnRows(id);
    assert.equal(row.decay_days, 1, 'Auckland ist der 10.10., Faelligkeit war der 9.10.');
    assert.equal(row.delta, 4);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});

test('Setting an: am Faelligkeitstag selbst kein Abzug', () => {
  const id = makeTask({ points: 3, dueDate: '2026-10-10' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 3);
  assert.equal(row.decay_days, null);
});

test('Setting an: künftige Faelligkeit kein Abzug', () => {
  const id = makeTask({ points: 3, dueDate: '2026-10-20' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 3);
  assert.equal(row.decay_days, null);
});

// ----------------------------------------------------------
// Grenzfaelle ohne Abzug
// ----------------------------------------------------------
test('Ohne due_date nie ueberfaellig', () => {
  const id = makeTask({ points: 6, dueDate: null });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 6);
  assert.equal(row.decay_days, null);
});

test('Ungueltiges due_date loest keinen Abzug aus', () => {
  const id = makeTask({ points: 6, dueDate: '2026-13-99' });
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  const [row] = earnRows(id);
  assert.equal(row.delta, 6);
  assert.equal(row.decay_days, null);
});

// ----------------------------------------------------------
// Storno bleibt korrekt bei reduzierter Gutschrift
// ----------------------------------------------------------
test('Storno nach Spaetabzug hebt genau den gebuchten Betrag auf', () => {
  setDecay(true);
  const id = makeTask({ points: 5, dueDate: '2026-10-05' });
  const base = getBalance(db, kid);
  awardForCompletion(db, id, admin, kid, { now: DONE_ON(10) });
  // 5 Tage ueberfaellig, 5 Punkte -> Untergrenze 1 Punkt.
  assert.equal(getBalance(db, kid) - base, 1);
  const [row] = earnRows(id);
  assert.equal(row.decay_days, 5);
  assert.equal(row.base_points, 5);
  reverseTaskEarnings(db, id, admin);
  assert.equal(getBalance(db, kid), base);
});
