/**
 * Modul: Budget - wiederkehrende Einträge (Intervall + virtuelles Budget) - Tests
 * Zweck: Validiert generateRecurringInstances für monthly/half_year/yearly,
 *        virtuelles (geglättetes) Budget, Idempotenz und übersprungene Monate.
 * Ausführen: node --experimental-sqlite test/test-budget-recurrence.js
 */

import { DatabaseSync } from 'node:sqlite';
import {
  generateRecurringInstances,
  monthsPerInterval,
  effectiveMonthly,
} from '../server/routes/budget.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT, display_name TEXT, password_hash TEXT, role TEXT
    );
    CREATE TABLE budget_entries (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      title                  TEXT    NOT NULL,
      amount                 REAL    NOT NULL,
      category               TEXT    NOT NULL DEFAULT 'Sonstiges',
      subcategory            TEXT    NOT NULL DEFAULT '',
      date                   TEXT    NOT NULL,
      is_recurring           INTEGER NOT NULL DEFAULT 0,
      recurrence_rule        TEXT,
      recurrence_parent_id   INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
      recurrence_interval    TEXT    NOT NULL DEFAULT 'monthly',
      recurrence_virtual     INTEGER NOT NULL DEFAULT 0,
      recurrence_full_amount REAL,
      created_by             INTEGER NOT NULL,
      created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE budget_recurrence_skipped (
      parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      month     TEXT    NOT NULL,
      UNIQUE(parent_id, month)
    );
    INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('admin', 'Admin', 'x', 'admin');
  `);
  return db;
}

/** Legt ein Serien-Original an und gibt dessen id zurück. */
function insertParent(db, { amount, date, interval = 'monthly', virtual = 0, full = null }) {
  const r = db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring,
       recurrence_interval, recurrence_virtual, recurrence_full_amount, created_by)
    VALUES ('Serie', ?, 'housing', 'utilities', ?, 1, ?, ?, ?, 1)
  `).run(amount, date, interval, virtual, full);
  return r.lastInsertRowid;
}

function instances(db, parentId) {
  return db.prepare(
    'SELECT * FROM budget_entries WHERE recurrence_parent_id = ? ORDER BY date ASC'
  ).all(parentId);
}
function instanceIn(db, parentId, month) {
  return db.prepare(`
    SELECT * FROM budget_entries WHERE recurrence_parent_id = ? AND date BETWEEN ? AND ?
  `).get(parentId, `${month}-01`, `${month}-31`);
}

console.log('\n[Budget-Recurrence-Test] Intervalle + virtuelles Budget\n');

// --------------------------------------------------------
// Reine Helper
// --------------------------------------------------------

test('monthsPerInterval bildet Intervalle korrekt ab', () => {
  assert(monthsPerInterval('monthly') === 1);
  assert(monthsPerInterval('half_year') === 6);
  assert(monthsPerInterval('yearly') === 12);
  assert(monthsPerInterval('unknown') === 1, 'Fallback auf monatlich');
});

test('effectiveMonthly glättet den Periodenbetrag auf Monate', () => {
  assert(effectiveMonthly(-1200, 'yearly') === -100, `yearly: ${effectiveMonthly(-1200, 'yearly')}`);
  assert(effectiveMonthly(-600, 'half_year') === -100, `half_year: ${effectiveMonthly(-600, 'half_year')}`);
  assert(effectiveMonthly(-100, 'monthly') === -100, `monthly: ${effectiveMonthly(-100, 'monthly')}`);
});

// --------------------------------------------------------
// Nicht-virtuell: echte Kadenz
// --------------------------------------------------------

test('Monatlich erzeugt in jedem Folgemonat den vollen Betrag', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2026-03');
  const inst = instanceIn(db, pid, '2026-03');
  assert(inst, 'Instanz für März vorhanden');
  assert(inst.amount === -950, `Voller Betrag: ${inst.amount}`);
  assert(inst.date === '2026-03-15', `Gleicher Tag: ${inst.date}`);
  assert(inst.is_recurring === 0, 'Instanz ist kein Serien-Original');
});

test('Jährlich erzeugt nur im Jahrestag-Monat', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -1200, date: '2026-01-15', interval: 'yearly' });
  generateRecurringInstances(db, '2026-06'); // monthsDiff 5 → kein Treffer
  assert(!instanceIn(db, pid, '2026-06'), 'Juni 2026 ohne Instanz');
  generateRecurringInstances(db, '2027-01'); // monthsDiff 12 → Treffer
  const inst = instanceIn(db, pid, '2027-01');
  assert(inst, 'Januar 2027 hat Instanz');
  assert(inst.amount === -1200, `Voller Jahresbetrag: ${inst.amount}`);
});

test('Halbjährlich erzeugt alle 6 Monate', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -600, date: '2026-01-10', interval: 'half_year' });
  generateRecurringInstances(db, '2026-04'); // diff 3 → kein Treffer
  assert(!instanceIn(db, pid, '2026-04'), 'April ohne Instanz');
  generateRecurringInstances(db, '2026-07'); // diff 6 → Treffer
  const inst = instanceIn(db, pid, '2026-07');
  assert(inst && inst.amount === -600, 'Juli hat vollen Betrag');
});

// --------------------------------------------------------
// Virtuell: geglättet auf jeden Monat
// --------------------------------------------------------

test('Virtuell jährlich erzeugt jeden Monat den geglätteten Anteil', () => {
  const db = freshDb();
  // Original hält bereits den Monatsanteil (-100), full = -1200.
  const pid = insertParent(db, {
    amount: -100, date: '2026-01-15', interval: 'yearly', virtual: 1, full: -1200,
  });
  for (const month of ['2026-02', '2026-05', '2026-11']) {
    generateRecurringInstances(db, month);
    const inst = instanceIn(db, pid, month);
    assert(inst, `Instanz für ${month}`);
    assert(inst.amount === -100, `${month}: geglätteter Anteil, erhalten ${inst.amount}`);
  }
});

test('Virtuell halbjährlich erzeugt auch in Nicht-Fälligkeitsmonaten', () => {
  const db = freshDb();
  const pid = insertParent(db, {
    amount: -100, date: '2026-01-10', interval: 'half_year', virtual: 1, full: -600,
  });
  generateRecurringInstances(db, '2026-03'); // bei nicht-virtuell wäre das leer
  const inst = instanceIn(db, pid, '2026-03');
  assert(inst && inst.amount === -100, 'März hat geglätteten Anteil');
});

// --------------------------------------------------------
// Idempotenz + übersprungene Monate
// --------------------------------------------------------

test('Mehrfaches Generieren dupliziert nicht', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2026-03');
  generateRecurringInstances(db, '2026-03');
  const all = instances(db, pid).filter((e) => e.date.startsWith('2026-03'));
  assert(all.length === 1, `Genau eine März-Instanz, erhalten ${all.length}`);
});

test('Übersprungener Monat erzeugt keine Instanz', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)').run(pid, '2026-03');
  generateRecurringInstances(db, '2026-03');
  assert(!instanceIn(db, pid, '2026-03'), 'März bleibt leer (übersprungen)');
});

test('Startmonat selbst bekommt keine zusätzliche Instanz', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2026-01');
  assert(!instanceIn(db, pid, '2026-01'), 'Startmonat ohne Kind-Instanz');
});

// --------------------------------------------------------
// Serien-Löschung (DELETE /series-Logik)
// --------------------------------------------------------
console.log('\n[Budget-Recurrence-Test] Serien-Löschung + Serien-Update\n');

test('DELETE series: löscht Parent und alle Kinder', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -100, date: '2025-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2025-02');
  generateRecurringInstances(db, '2025-03');
  const before = instances(db, pid);
  assert(before.length === 2, `Sollte 2 Kinder haben, hat ${before.length}`);

  // Serienlogik: alle Kinder löschen, dann Parent
  db.prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ?').run(pid);
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(pid);

  const parentGone = !db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(pid);
  assert(parentGone, 'Parent wurde nicht gelöscht');
  const childrenGone = instances(db, pid).length === 0;
  assert(childrenGone, 'Kinder wurden nicht gelöscht');
});

test('DELETE series via Kind-ID: findet Parent korrekt', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -200, date: '2025-01-10', interval: 'monthly' });
  generateRecurringInstances(db, '2025-02');
  const child = instanceIn(db, pid, '2025-02');
  assert(child, 'Kind für Feb vorhanden');

  // Route-Logik: parentId = child.recurrence_parent_id
  const entry = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(child.id);
  const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
  assert(parentId === pid, `parentId sollte ${pid} sein, ist ${parentId}`);

  db.prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ?').run(parentId);
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(parentId);

  assert(!db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(pid), 'Parent weg');
  assert(!db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(child.id), 'Kind weg');
});

test('PUT series: aktualisiert Parent und löscht Zukunfts-Kinder', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -100, date: '2025-01-15', interval: 'monthly' });
  // Vergangene Instanz (bleibt erhalten)
  generateRecurringInstances(db, '2025-02');
  // Zukünftige Instanz im aktuellen oder späteren Monat (wird gelöscht)
  const future = '2030-01';
  generateRecurringInstances(db, future);
  const futureInst = instanceIn(db, pid, future);
  assert(futureInst, 'Zukünftige Instanz vorhanden');

  // Route-Logik: Parent aktualisieren, Kinder ab cutoff löschen
  const cutoff = '2030-01-01';
  db.prepare(`UPDATE budget_entries SET title = 'Neue Miete', amount = -120 WHERE id = ?`).run(pid);
  db.prepare(`DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?`).run(pid, cutoff);

  const updated = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(pid);
  assert(updated.title === 'Neue Miete', 'Parent-Titel aktualisiert');
  assert(updated.amount === -120, 'Parent-Betrag aktualisiert');

  const futureGone = !db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(futureInst.id);
  assert(futureGone, 'Zukünftige Instanz wurde gelöscht');

  const pastInst = instanceIn(db, pid, '2025-02');
  assert(pastInst, 'Vergangene Instanz bleibt erhalten');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Budget-Recurrence-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
