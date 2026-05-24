/**
 * Modul: Notes / Contacts / Budget - Tests
 * Zweck: Validiert CRUD, Constraints, Filterabfragen, Aggregation für alle drei Module
 * Ausführen: node --experimental-sqlite test-notes-contacts-budget.js
 */

import { DatabaseSync } from 'node:sqlite';
import nodeAssert from 'node:assert/strict';
import { MIGRATIONS_SQL } from './server/db-schema-test.js';
import { budgetCategoryLabelKey } from './public/utils/category-labels.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;

// ============================================================
// NOTES
// ============================================================
console.log('\n[Notes-Test] Notizen, Pin, Sortierung\n');

let noteId1, noteId2, noteId3;

test('Notiz erstellen', () => {
  const r = db.prepare(`INSERT INTO notes (content, color, pinned, created_by)
    VALUES ('Einkaufen nicht vergessen', '#FFEB3B', 0, ?)`).run(uid);
  noteId1 = r.lastInsertRowid;
  assert(noteId1 > 0);
});

test('Zweite Notiz mit Titel erstellen', () => {
  const r = db.prepare(`INSERT INTO notes (title, content, color, pinned, created_by)
    VALUES ('Wichtig', 'Arzttermin morgen', '#90CAF9', 1, ?)`).run(uid);
  noteId2 = r.lastInsertRowid;
  assert(noteId2 > 0);
});

test('Dritte Notiz erstellen', () => {
  const r = db.prepare(`INSERT INTO notes (content, color, created_by)
    VALUES ('Notiz drei', '#A5D6A7', ?)`).run(uid);
  noteId3 = r.lastInsertRowid;
  assert(noteId3 > 0);
});

test('Sortierung: Angepinnte zuerst', () => {
  const notes = db.prepare(`
    SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC
  `).all();
  assert(notes.length === 3);
  assert(notes[0].pinned === 1, `Erste Notiz muss angeheftet sein, ist: ${notes[0].pinned}`);
});

test('Notiz aktualisieren (Inhalt + Farbe)', () => {
  db.prepare(`UPDATE notes SET content = 'Neuer Inhalt', color = '#FF9500' WHERE id = ?`).run(noteId1);
  const n = db.prepare('SELECT content, color FROM notes WHERE id = ?').get(noteId1);
  assert(n.content === 'Neuer Inhalt');
  assert(n.color === '#FF9500');
});

test('Pin-Toggle: pinned 0 → 1', () => {
  const before = db.prepare('SELECT pinned FROM notes WHERE id = ?').get(noteId1);
  const newPin = before.pinned ? 0 : 1;
  db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(newPin, noteId1);
  const after = db.prepare('SELECT pinned FROM notes WHERE id = ?').get(noteId1);
  assert(after.pinned === 1, 'Jetzt angeheftet');
});

test('Notiz löschen', () => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(noteId3);
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId3);
  assert(!n, 'Notiz gelöscht');
});

test('Verbleibende Notizen nach Löschung: 2', () => {
  const notes = db.prepare('SELECT * FROM notes').all();
  assert(notes.length === 2, `Erwartet 2, erhalten ${notes.length}`);
});

test('JOIN: Ersteller-Name verfügbar', () => {
  const n = db.prepare(`
    SELECT n.*, u.display_name AS creator_name
    FROM notes n LEFT JOIN users u ON u.id = n.created_by
    WHERE n.id = ?
  `).get(noteId2);
  assert(n.creator_name === 'Admin');
});

test('Index idx_notes_pinned genutzt', () => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM notes WHERE pinned = 1`).all();
  const usesIndex = plan.some((r) => (r.detail || '').includes('INDEX'));
  assert(usesIndex, JSON.stringify(plan));
});

// ============================================================
// CONTACTS
// ============================================================
console.log('\n[Contacts-Test] CRUD, Kategorien, Suche\n');

let cId1, cId2, cId3;

test('Kontakt erstellen (Arzt)', () => {
  const r = db.prepare(`INSERT INTO contacts (name, category, phone, email)
    VALUES ('Dr. Müller', 'Arzt', '+49 30 12345', 'mueller@praxis.de')`).run();
  cId1 = r.lastInsertRowid;
  assert(cId1 > 0);
});

test('Kontakt erstellen (Notfall)', () => {
  const r = db.prepare(`INSERT INTO contacts (name, category, phone)
    VALUES ('Feuerwehr', 'Notfall', '112')`).run();
  cId2 = r.lastInsertRowid;
  assert(cId2 > 0);
});

test('Kontakt erstellen (Handwerker)', () => {
  const r = db.prepare(`INSERT INTO contacts (name, category, phone, address)
    VALUES ('Klempner Fritz', 'Handwerker', '+49 170 99999', 'Musterstr. 1, Berlin')`).run();
  cId3 = r.lastInsertRowid;
  assert(cId3 > 0);
});

test('Alle Kontakte abrufen', () => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY category ASC, name ASC').all();
  assert(contacts.length === 3);
});

test('Nach Kategorie filtern (Arzt)', () => {
  const contacts = db.prepare(`SELECT * FROM contacts WHERE category = 'Arzt'`).all();
  assert(contacts.length === 1);
  assert(contacts[0].name === 'Dr. Müller');
});

test('Volltextsuche nach Name', () => {
  const q     = '%Feuerwehr%';
  const contacts = db.prepare(`
    SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?
  `).all(q, q, q);
  assert(contacts.length === 1);
  assert(contacts[0].category === 'Notfall');
});

test('Suche nach Telefonnummer', () => {
  const q = '%112%';
  const contacts = db.prepare(`SELECT * FROM contacts WHERE phone LIKE ?`).all(q);
  assert(contacts.length === 1);
});

test('Kontakt aktualisieren', () => {
  db.prepare(`UPDATE contacts SET phone = '+49 30 99999' WHERE id = ?`).run(cId1);
  const c = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(cId1);
  assert(c.phone === '+49 30 99999');
});

test('Kontakt löschen', () => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(cId3);
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cId3);
  assert(!c, 'Kontakt gelöscht');
});

// ============================================================
// BUDGET
// ============================================================
console.log('\n[Budget-Test] Einnahmen, Ausgaben, Saldo, Aggregation, CSV-Vorbereitung\n');

let bId1, bId2, bId3, bId4;

test('Budget-Kategorie-Labels mappen bekannte Rohwerte auf Übersetzungsschlüssel', () => {
  nodeAssert.equal(budgetCategoryLabelKey('income'), 'budget.categoryIncome');
  nodeAssert.equal(budgetCategoryLabelKey('utilities'), 'budget.categoryUtilities');
  nodeAssert.equal(budgetCategoryLabelKey('custom'), null);
});

test('Ausgabe eintragen (Supermarkt)', () => {
  const r = db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
    VALUES ('REWE', -85.40, 'food', 'groceries', '2026-03-10', ?)`).run(uid);
  bId1 = r.lastInsertRowid;
  assert(bId1 > 0);
});

test('Einnahme eintragen (Gehalt)', () => {
  const r = db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by)
    VALUES ('Gehalt März', 2800.00, 'Sonstiges Einkommen', '2026-03-01', ?)`).run(uid);
  bId2 = r.lastInsertRowid;
  assert(bId2 > 0);
});

test('Ausgabe (Aluguel / Prestação)', () => {
  const r = db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
    VALUES ('Miete', -950.00, 'housing', 'rent_mortgage', '2026-03-01', 1, ?)`).run(uid);
  bId3 = r.lastInsertRowid;
  assert(bId3 > 0);
});

test('Ausgabe im anderen Monat (April)', () => {
  const r = db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
    VALUES ('Strom April', -55.00, 'housing', 'utilities', '2026-04-15', ?)`).run(uid);
  bId4 = r.lastInsertRowid;
  assert(bId4 > 0);
});

test('Monatsfilter März: nur März-Einträge', () => {
  const entries = db.prepare(`
    SELECT * FROM budget_entries WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
    ORDER BY date ASC
  `).all();
  assert(entries.length === 3, `Erwartet 3, erhalten ${entries.length}`);
});

test('Monatsfilter April: nur April-Eintrag', () => {
  const entries = db.prepare(`
    SELECT * FROM budget_entries WHERE date BETWEEN '2026-04-01' AND '2026-04-30'
  `).all();
  assert(entries.length === 1);
  assert(entries[0].title === 'Strom April');
});

test('Einnahmen-Summe März', () => {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income
    FROM budget_entries WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
  `).get();
  assert(Math.abs(row.income - 2800.00) < 0.01, `Einnahmen: ${row.income}`);
});

test('Ausgaben-Summe März', () => {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses
    FROM budget_entries WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
  `).get();
  const expected = -(85.40 + 950.00);
  assert(Math.abs(row.expenses - expected) < 0.01, `Ausgaben: ${row.expenses}`);
});

test('Saldo März positiv', () => {
  const row = db.prepare(`
    SELECT SUM(amount) AS balance
    FROM budget_entries WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
  `).get();
  assert(row.balance > 0, `Saldo: ${row.balance}`);
});

test('Aggregation nach Kategorie', () => {
  const cats = db.prepare(`
    SELECT category,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
           SUM(amount) AS total
    FROM budget_entries
    WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
    GROUP BY category ORDER BY ABS(SUM(amount)) DESC
  `).all();
  assert(cats.length >= 2, `Mindestens 2 Kategorien, erhalten ${cats.length}`);
  // Housing should be the largest expense category.
  const miete = cats.find((c) => c.category === 'housing');
  assert(miete, 'Housing in Kategorien vorhanden');
  assert(Math.abs(miete.expenses + 950.00) < 0.01, `Miete-Ausgaben: ${miete.expenses}`);
});

test('Unterkategorie gespeichert', () => {
  const r = db.prepare('SELECT category, subcategory FROM budget_entries WHERE id = ?').get(bId1);
  assert(r.category === 'food', `Kategorie: ${r.category}`);
  assert(r.subcategory === 'groceries', `Unterkategorie: ${r.subcategory}`);
});

test('Wiederkehrend-Flag korrekt', () => {
  const r = db.prepare('SELECT is_recurring FROM budget_entries WHERE id = ?').get(bId3);
  assert(r.is_recurring === 1, 'Miete ist wiederkehrend');
});

test('Eintrag aktualisieren', () => {
  db.prepare(`UPDATE budget_entries SET amount = -90.50 WHERE id = ?`).run(bId1);
  const e = db.prepare('SELECT amount FROM budget_entries WHERE id = ?').get(bId1);
  assert(Math.abs(e.amount + 90.50) < 0.01);
});

test('Eintrag löschen', () => {
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(bId4);
  const e = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(bId4);
  assert(!e, 'Eintrag gelöscht');
});

test('CSV-Vorbereitung: alle März-Einträge mit JOIN', () => {
  const entries = db.prepare(`
    SELECT b.*, u.display_name AS creator_name
    FROM budget_entries b
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.date BETWEEN '2026-03-01' AND '2026-03-31'
    ORDER BY b.date ASC
  `).all();
  assert(entries.length === 3);
  assert(entries[0].creator_name === 'Admin');
});

test('Index idx_budget_date genutzt', () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN SELECT * FROM budget_entries WHERE date BETWEEN '2026-03-01' AND '2026-03-31'
  `).all();
  const usesIndex = plan.some((r) => (r.detail || '').includes('INDEX'));
  assert(usesIndex, JSON.stringify(plan));
});

test('Empréstimo com parcelas calcula restante', () => {
  const loan = db.prepare(`
    INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
    VALUES ('Empréstimo Lais', 'Lais', 1000, 5, '2026-03', ?)
  `).run(uid);
  const loanId = loan.lastInsertRowid;

  const entry = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by)
    VALUES ('Loan repayment: Lais', 200, 'Geschenke & Transfers', '2026-03-05', ?)
  `).run(uid);
  db.prepare(`
    INSERT INTO budget_loan_payments
      (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
    VALUES (?, 1, 200, '2026-03-05', ?, ?)
  `).run(loanId, entry.lastInsertRowid, uid);

  const totals = db.prepare(`
    SELECT l.total_amount,
           l.installment_count,
           COUNT(p.id) AS paid_installments,
           COALESCE(SUM(p.amount), 0) AS paid_amount
    FROM budget_loans l
    LEFT JOIN budget_loan_payments p ON p.loan_id = l.id
    WHERE l.id = ?
    GROUP BY l.id
  `).get(loanId);

  assert(totals.paid_installments === 1, `Parcelas pagas: ${totals.paid_installments}`);
  assert(Math.abs(totals.paid_amount - 200) < 0.01, `Pago: ${totals.paid_amount}`);
  assert(Math.abs((totals.total_amount - totals.paid_amount) - 800) < 0.01, 'Restante deve ser 800');
  assert(totals.installment_count - totals.paid_installments === 4, 'Devem restar 4 parcelas');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Notes/Contacts/Budget-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
