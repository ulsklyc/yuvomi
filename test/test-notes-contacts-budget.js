/**
 * Modul: Notes / Contacts / Budget - Tests
 * Zweck: Validiert CRUD, Constraints, Filterabfragen, Aggregation für alle drei Module
 * Ausführen: node --experimental-sqlite test-notes-contacts-budget.js
 */

import { DatabaseSync } from 'node:sqlite';
import nodeAssert from 'node:assert/strict';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { budgetCategoryLabelKey } from '../public/utils/category-labels.js';
import {
  categoryInUseCount,
  subcategoryInUseCount,
  categoryCountByType,
  subcategoryCountForCategory,
} from '../server/routes/budget.js';

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

// --- Guard-Helfer (Kategorienverwaltung) ---
// Fixtures: Kategorien/Subkategorien selbst seeden (Test-Schema seedet sie nicht).
console.log('\n[Budget-Guards] Kategorie-Verwaltung\n');
db.exec(`
  INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order) VALUES
    ('housing', 'Housing', 'expense', 0),
    ('food', 'Food', 'expense', 1),
    ('leisure', 'Leisure', 'expense', 2),
    ('inc_main', 'Haupteinkommen', 'income', 0);
  INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order) VALUES
    ('rent_mortgage', 'housing', 'Miete', 0),
    ('condominium', 'housing', 'Hausgeld', 1),
    ('utilities', 'housing', 'Nebenkosten', 2),
    ('groceries', 'food', 'Lebensmittel', 0);
`);

test('Guard: categoryInUseCount zählt Einträge der Kategorie', () => {
  // 'housing' hat aus den bestehenden Budget-Tests >=1 Eintrag; 'leisure' ist frei.
  assert(categoryInUseCount(db, 'housing') >= 1, 'housing muss >=1 Eintrag haben');
  assert(categoryInUseCount(db, 'leisure') === 0, 'leisure muss 0 Einträge haben');
});

test('Guard: subcategoryInUseCount zählt Einträge der Subkategorie', () => {
  assert(subcategoryInUseCount(db, 'rent_mortgage') >= 1, 'rent_mortgage muss in Benutzung sein');
  assert(subcategoryInUseCount(db, 'condominium') === 0, 'condominium muss frei sein');
});

test('Guard: categoryCountByType zählt Kategorien je Typ', () => {
  assert(categoryCountByType(db, 'expense') === 3, 'expense: housing, food, leisure');
  assert(categoryCountByType(db, 'income') === 1, 'income: inc_main');
});

test('Guard: subcategoryCountForCategory zählt Subkategorien einer Kategorie', () => {
  assert(subcategoryCountForCategory(db, 'housing') === 3, 'housing hat 3 Subkategorien');
  assert(subcategoryCountForCategory(db, 'food') === 1, 'food hat 1 Subkategorie');
});

// --- Endpunkte: PUT/DELETE/PATCH-reorder Kategorien (DB-Level, gespiegelt an Routen) ---
test('Kategorie umbenennen: name wird aktualisiert, key bleibt', () => {
  db.prepare("UPDATE budget_categories SET name = ? WHERE key = 'food'").run('Lebensmittel');
  const row = db.prepare("SELECT name FROM budget_categories WHERE key = 'food'").get();
  assert(row.name === 'Lebensmittel', 'Name muss aktualisiert sein');
});

test('PUT /categories/:key Konflikt-Query: erkennt Namenskollision innerhalb desselben Typs (case-insensitive)', () => {
  db.exec(`
    INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order) VALUES
      ('rename_a', 'Alpha', 'expense', 20),
      ('rename_b', 'Beta', 'expense', 21),
      ('rename_inc', 'Beta', 'income', 22);
  `);

  const conflictQuery = `
    SELECT key FROM budget_categories WHERE type = ? AND name = ? COLLATE NOCASE AND key != ?
  `;

  // Umbenennen von rename_a -> 'beta' (case-insensitive Treffer auf rename_b, gleicher Typ) -> Konflikt.
  const collision = db.prepare(conflictQuery).get('expense', 'beta', 'rename_a');
  assert(collision !== undefined, 'Umbenennen auf einen bereits vergebenen Namen (case-insensitive) muss einen Konflikt liefern -> Endpunkt liefert 409');
  assert(collision.key === 'rename_b', 'Der gemeldete Konflikt muss auf die andere Kategorie (rename_b) zeigen');

  // Umbenennen von rename_a -> eigener aktueller Name 'Alpha' -> kein Konflikt (key != ? schließt sich selbst aus).
  const selfRename = db.prepare(conflictQuery).get('expense', 'Alpha', 'rename_a');
  assert(selfRename === undefined, 'Umbenennen auf den eigenen aktuellen Namen darf KEINEN Konflikt liefern (key != ? schließt die Kategorie selbst aus)');

  // rename_inc (income) heißt ebenfalls 'Beta' -- exakt wie rename_b (expense).
  // Beim Umbenennen von rename_inc (income) auf 'Beta' darf NUR der eigene Typ (income) geprüft werden;
  // rename_b (expense, gleicher Name) liegt im anderen Typ und darf keinen Konflikt auslösen.
  const crossType = db.prepare(conflictQuery).get('income', 'Beta', 'rename_inc');
  assert(crossType === undefined, 'Gleicher Name in einem ANDEREN Typ (expense: rename_b) darf keinen Konflikt für die income-Umbenennung von rename_inc auslösen -> type-Scoping greift');

  db.exec("DELETE FROM budget_categories WHERE key IN ('rename_a','rename_b','rename_inc')");
});

test('Kategorie löschen blockiert, wenn in Benutzung (Guard hat Priorität vor letzter-Kategorie-Check)', () => {
  // Endpunkt-Reihenfolge (server/routes/budget.js DELETE /categories/:key):
  // 1. inUse > 0  -> 409 "in use"      (geprüft zuerst)
  // 2. countByType <= 1 -> 409 "last"  (nur falls inUse === 0)
  const inUse = categoryInUseCount(db, 'housing');
  const blockedByInUse = inUse > 0;
  assert(blockedByInUse === true, 'housing muss in Benutzung sein -> Endpunkt liefert 409 "in use", BEVOR der letzte-Kategorie-Check überhaupt ausgewertet wird');
  // Der in-use-Guard greift unabhängig davon, ob housing auch die letzte ihres Typs wäre.
  assert(categoryCountByType(db, 'expense') > 1, 'Kontrolle: housing ist hier nicht die letzte expense-Kategorie, der Block kommt also wirklich vom in-use-Guard');
});

test('Kategorie löschen blockiert, wenn letzte ihres Typs (Guard greift nur wenn NICHT in Benutzung)', () => {
  // inc_main ist frei (keine Budgeteinträge) UND die einzige income-Kategorie
  // -> erster Guard (inUse) lässt durch, zweiter Guard (countByType<=1) blockiert -> 409 "last".
  const inUse = categoryInUseCount(db, 'inc_main');
  assert(inUse === 0, 'inc_main muss frei sein, sonst würde der in-use-Guard zuerst greifen, nicht der letzte-Kategorie-Guard');
  const blockedByLastOfType = categoryCountByType(db, 'income') <= 1;
  assert(blockedByLastOfType === true, 'Nur eine income-Kategorie -> letzter-Guard greift -> Endpunkt liefert 409 "last category"');
});

test('Kategorie löschen erlaubt, wenn frei und nicht letzte: Subkategorien per ON DELETE CASCADE entfernt', () => {
  // Wegwerf-Kategorie mit Subkategorie anlegen, dann löschen.
  db.exec(`
    INSERT INTO budget_categories (key, name, type, sort_order) VALUES ('misc', 'Misc', 'expense', 9);
    INSERT INTO budget_subcategories (key, category_key, name, sort_order) VALUES ('misc_sub', 'misc', 'Sub', 0);
  `);
  assert(categoryInUseCount(db, 'misc') === 0, 'misc muss frei sein');
  assert(categoryCountByType(db, 'expense') > 1, 'misc ist nicht die letzte expense-Kategorie');
  db.prepare('DELETE FROM budget_categories WHERE key = ?').run('misc');
  const sub = db.prepare("SELECT COUNT(*) AS n FROM budget_subcategories WHERE category_key = 'misc'").get().n;
  assert(sub === 0, 'Subkategorien müssen per Cascade entfernt sein');
});

test('Reorder: sort_order folgt der übergebenen Reihenfolge', () => {
  const expense = db.prepare("SELECT key FROM budget_categories WHERE type='expense' ORDER BY sort_order").all().map(r => r.key);
  const reversed = [...expense].reverse();
  reversed.forEach((key, i) => db.prepare('UPDATE budget_categories SET sort_order = ? WHERE key = ? AND type = ?').run(i, key, 'expense'));
  const after = db.prepare("SELECT key FROM budget_categories WHERE type='expense' ORDER BY sort_order").all().map(r => r.key);
  assert(after[0] === reversed[0], 'Erste Kategorie muss der neuen Reihenfolge entsprechen');
});

// --- Endpunkte: PUT/DELETE/PATCH-reorder Subkategorien (DB-Level, gespiegelt an Routen) ---
// Achtung: 'utilities' ist durch den bestehenden „Strom April"-Eintrag der Budget-Tests in Benutzung
// -> hier 'condominium' als freie Subkategorie verwenden, NICHT 'utilities'.

test('Subkategorie löschen blockiert, wenn in Benutzung (Guard)', () => {
  assert(subcategoryInUseCount(db, 'rent_mortgage') > 0, 'rent_mortgage muss in Benutzung sein');
});

test('Subkategorie löschen erlaubt, wenn frei und nicht letzte', () => {
  assert(subcategoryInUseCount(db, 'condominium') === 0, 'condominium muss frei sein');
  assert(subcategoryCountForCategory(db, 'housing') > 1, 'housing muss >1 Subkategorie haben');
  db.prepare('DELETE FROM budget_subcategories WHERE key = ?').run('condominium');
  assert(subcategoryCountForCategory(db, 'housing') >= 1, 'housing behält >=1 Subkategorie');
});

test('Subkategorie umbenennen: name aktualisiert', () => {
  db.prepare("UPDATE budget_subcategories SET name = ? WHERE key = 'utilities'").run('Nebenkosten neu');
  const row = db.prepare("SELECT name FROM budget_subcategories WHERE key = 'utilities'").get();
  assert(row.name === 'Nebenkosten neu', 'Name muss aktualisiert sein');
});

test('PUT /categories/:key/subcategories/:subKey Konflikt-Query: erkennt Namenskollision innerhalb derselben Kategorie (case-insensitive)', () => {
  // 'rent_mortgage' (housing) heißt 'Miete'; 'groceries' (food) heißt 'Lebensmittel'.
  db.exec(`
    INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order) VALUES
      ('sub_rename_a', 'housing', 'Sub Alpha', 10),
      ('sub_rename_b', 'housing', 'Sub Beta', 11),
      ('sub_rename_food', 'food', 'Sub Beta', 0);
  `);

  const conflictQuery = `
    SELECT key FROM budget_subcategories WHERE category_key = ? AND name = ? COLLATE NOCASE AND key != ?
  `;

  // Umbenennen von sub_rename_a -> 'sub beta' (case-insensitive Treffer auf sub_rename_b, gleiche Kategorie) -> Konflikt.
  const collision = db.prepare(conflictQuery).get('housing', 'sub beta', 'sub_rename_a');
  assert(collision !== undefined, 'Umbenennen auf einen bereits vergebenen Namen (case-insensitive) innerhalb derselben Kategorie muss einen Konflikt liefern -> Endpunkt liefert 409');
  assert(collision.key === 'sub_rename_b', 'Der gemeldete Konflikt muss auf die andere Subkategorie (sub_rename_b) zeigen');

  // Umbenennen von sub_rename_a -> eigener aktueller Name 'Sub Alpha' -> kein Konflikt (key != ? schließt sich selbst aus).
  const selfRename = db.prepare(conflictQuery).get('housing', 'Sub Alpha', 'sub_rename_a');
  assert(selfRename === undefined, 'Umbenennen auf den eigenen aktuellen Namen darf KEINEN Konflikt liefern (key != ? schließt die Subkategorie selbst aus)');

  // sub_rename_food (Kategorie food) heißt ebenfalls 'Sub Beta' -- exakt wie sub_rename_b (Kategorie housing).
  // Beim Umbenennen von sub_rename_food auf 'Sub Beta' darf NUR innerhalb der eigenen Kategorie (food) geprüft werden;
  // sub_rename_b (housing, gleicher Name) liegt in einer anderen Kategorie und darf keinen Konflikt auslösen.
  const crossCategory = db.prepare(conflictQuery).get('food', 'Sub Beta', 'sub_rename_food');
  assert(crossCategory === undefined, 'Gleicher Name in einer ANDEREN Kategorie (housing: sub_rename_b) darf keinen Konflikt für die Umbenennung von sub_rename_food (food) auslösen -> category_key-Scoping greift');

  db.exec("DELETE FROM budget_subcategories WHERE key IN ('sub_rename_a','sub_rename_b','sub_rename_food')");
});

test('Subkategorie-Reorder: sort_order folgt der übergebenen Reihenfolge, scoped auf category_key', () => {
  const housingSubs = db.prepare("SELECT key FROM budget_subcategories WHERE category_key='housing' ORDER BY sort_order").all().map(r => r.key);
  const reversed = [...housingSubs].reverse();
  reversed.forEach((key, i) => db.prepare('UPDATE budget_subcategories SET sort_order = ? WHERE key = ? AND category_key = ?').run(i, key, 'housing'));
  const after = db.prepare("SELECT key FROM budget_subcategories WHERE category_key='housing' ORDER BY sort_order").all().map(r => r.key);
  assert(after[0] === reversed[0], 'Erste Subkategorie muss der neuen Reihenfolge entsprechen');
  // food-Subkategorien dürfen vom housing-Reorder unberührt bleiben (category_key-Scoping).
  const groceries = db.prepare("SELECT sort_order FROM budget_subcategories WHERE key = 'groceries'").get();
  assert(groceries.sort_order === 0, 'groceries (food) darf vom housing-Reorder nicht beeinflusst werden');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Notes/Contacts/Budget-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
