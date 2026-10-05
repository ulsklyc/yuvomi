/**
 * Modul: Budget-Sichtbarkeit (#476/#505, #659) - Tests
 * Zweck: Owner-basiertes Sichtbarkeitsmodell (private/shared/shared_amount),
 *        Ansichts-Scope (mine/household) und Schreib-Berechtigung.
 *        KEIN Admin-Bypass.
 *
 * Die dritte Stufe trennt zwei Fragen, die vorher eine waren: ob ein Eintrag
 * in die SUMMEN einfliesst und ob er seine DETAILS zeigt. Die Tests unten
 * pruefen beide Achsen einzeln - eine Stufe, die nur in einer Achse richtig
 * liegt, ist entweder ein Leck oder ein falscher Saldo.
 * Ausführen: node --experimental-sqlite test/test-budget-visibility.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  BUDGET_VISIBILITY_VALUES,
  BUDGET_OBJECT_VISIBILITY_VALUES,
  BUDGET_MASKED_CATEGORY,
  normalizeBudgetVisibility,
  normalizeObjectVisibility,
  budgetVisibilityWhere,
  budgetDetailsVisibleWhere,
  budgetDetailsHiddenWhere,
  budgetScopeWhere,
  hidesBudgetDetails,
  maskBudgetEntry,
  canEditEntry,
} from '../server/services/budget-visibility.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

// ============================================================
// Reine Helfer
// ============================================================
console.log('\n[Budget-Visibility] Reine Helfer\n');

test('BUDGET_VISIBILITY_VALUES = [private, shared, shared_amount]', () => {
  assert(JSON.stringify(BUDGET_VISIBILITY_VALUES)
    === JSON.stringify(['private', 'shared', 'shared_amount']));
});

test('Darlehen/Abos kennen weiterhin nur zwei Stufen', () => {
  assert(JSON.stringify(BUDGET_OBJECT_VISIBILITY_VALUES)
    === JSON.stringify(['private', 'shared']));
});

test('normalizeBudgetVisibility akzeptiert gültige Werte', () => {
  assert(normalizeBudgetVisibility('private') === 'private');
  assert(normalizeBudgetVisibility('shared') === 'shared');
  assert(normalizeBudgetVisibility('shared_amount') === 'shared_amount');
});

test('normalizeObjectVisibility rundet shared_amount NACH UNTEN, nicht nach oben', () => {
  // Wer die Stufe schickt, will den Zweck verbergen. Ein Darlehen kann das
  // nicht - auf 'shared' zu runden machte aus dem Wunsch sein Gegenteil.
  assert(normalizeObjectVisibility('shared_amount') === 'private');
  assert(normalizeObjectVisibility('private') === 'private');
  assert(normalizeObjectVisibility('shared') === 'shared');
  assert(normalizeObjectVisibility('bogus') === 'shared');
});

test('normalizeBudgetVisibility fällt auf shared zurück', () => {
  assert(normalizeBudgetVisibility('bogus') === 'shared');
  assert(normalizeBudgetVisibility(undefined) === 'shared');
  assert(normalizeBudgetVisibility(null, 'private') === 'private');
});

test('budgetVisibilityWhere: shared-Modus = 1=1 (Altverhalten)', () => {
  assert(budgetVisibilityWhere('b', '@me', { mode: 'shared' }) === '1=1');
  assert(budgetVisibilityWhere('b', '@me', {}) === '1=1');
});

test('budgetVisibilityWhere: personal-Modus laesst alles durch ausser fremd-privat', () => {
  const frag = budgetVisibilityWhere('b', '@me', { mode: 'personal' });
  assert(/b\.visibility <> 'private'/.test(frag), frag);
  assert(/b\.owner_id = @me/.test(frag), frag);
});

test('budgetDetailsVisibleWhere: nur echtes shared oder eigenes', () => {
  // Die Zweck-Achse: hier ist shared_amount so streng wie private.
  const frag = budgetDetailsVisibleWhere('b', '@me', { mode: 'personal' });
  assert(/b\.visibility = 'shared'/.test(frag), frag);
  assert(!/shared_amount/.test(frag), frag);
  assert(budgetDetailsVisibleWhere('b', '@me', { mode: 'shared' }) === '1=1');
});

test('budgetDetailsHiddenWhere: greift nur bei fremdem shared_amount', () => {
  const frag = budgetDetailsHiddenWhere('b', '@me', { mode: 'personal' });
  assert(/b\.visibility = 'shared_amount'/.test(frag), frag);
  assert(/b\.owner_id <> @me/.test(frag), frag);
  assert(budgetDetailsHiddenWhere('b', '@me', { mode: 'shared' }) === '0=1');
});

test('budgetScopeWhere: mine → owner, household → alles ausser privat', () => {
  assert(budgetScopeWhere('mine', 'b', '@me') === 'b.owner_id = @me');
  assert(budgetScopeWhere('household', 'b', '@me') === "b.visibility <> 'private'");
});

test('hidesBudgetDetails: nur fremdes shared_amount im personal-Modus', () => {
  assert(hidesBudgetDetails({ visibility: 'shared_amount', owner_id: 5 }, 9, 'personal') === true);
  assert(hidesBudgetDetails({ visibility: 'shared_amount', owner_id: 5 }, 5, 'personal') === false);
  assert(hidesBudgetDetails({ visibility: 'shared', owner_id: 5 }, 9, 'personal') === false);
  assert(hidesBudgetDetails({ visibility: 'shared_amount', owner_id: 5 }, 9, 'shared') === false);
});

test('maskBudgetEntry: Betrag bleibt, Zweck geht - inklusive Verknuepfungen', () => {
  const row = {
    id: 1, title: 'Overwatch-Skin', amount: -25, date: '2026-08-14', account_id: 3,
    category: 'leisure', subcategory: 'games', recurrence_rule: 'FREQ=MONTHLY',
    visibility: 'shared_amount', owner_id: 5,
    attachments: [{ id: 7, name: 'beleg.pdf' }],
    loan_payment_id: 4, loan_id: 2, loan_installment_number: 1,
    loan_title: 'Kredit Zahnspange', loan_borrower: 'Bank Geheim',
  };
  const masked = maskBudgetEntry(row, 9, 'personal');
  assert(masked.amount === -25, 'Betrag muss bleiben - er ist der Zweck der Stufe');
  assert(masked.date === '2026-08-14' && masked.account_id === 3, 'Datum/Konto bleiben');
  assert(masked.title === '', 'Titel weg');
  assert(masked.category === BUDGET_MASKED_CATEGORY, 'Sammel-Bucket statt echter Kategorie');
  assert(masked.subcategory === '', 'Unterkategorie weg');
  assert(masked.details_hidden === true, 'Flag fuer die Oberflaeche');
  assert(masked.attachments === undefined, 'Belege verraten den Zweck genauso');
  assert(masked.recurrence_rule === undefined, 'Wiederholungsregel weg');
  for (const key of ['loan_payment_id', 'loan_id', 'loan_installment_number', 'loan_title', 'loan_borrower']) {
    assert(masked[key] === undefined, `Darlehens-Verknuepfung ${key} weg`);
  }
  assert(!JSON.stringify(masked).includes('Overwatch'), 'kein Rest des Titels irgendwo');
});

test('maskBudgetEntry: Owner und shared-Modus sehen den Eintrag unveraendert', () => {
  const row = { title: 'Skin', category: 'leisure', visibility: 'shared_amount', owner_id: 5 };
  assert(maskBudgetEntry(row, 5, 'personal') === row, 'Owner sieht sein eigenes voll');
  assert(maskBudgetEntry(row, 9, 'shared') === row, 'shared-Modus maskiert nie');
});

test('canEditEntry: Owner oder Ersteller darf, sonst nicht (kein Admin-Bypass)', () => {
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 5 }) === true);
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 9 }) === true);
  assert(canEditEntry({ owner_id: 5, created_by: 9 }, { id: 1 }) === false);
  assert(canEditEntry(null, { id: 5 }) === false);
});

// ============================================================
// Integration: Enforcement über echte SQL-Fragmente
// ============================================================
console.log('\n[Budget-Visibility] Enforcement (SQL)\n');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

const A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('a', 'A', 'x', 'member')`).run().lastInsertRowid;
const B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('b', 'B', 'x', 'member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run().lastInsertRowid;

function addEntry(title, owner, visibility) {
  return db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES (?, -10, 'Sonstiges', '2026-07-01', ?, ?, ?)`).run(title, owner, owner, visibility).lastInsertRowid;
}
const aPriv   = addEntry('A privat',   A, 'private');
const aShared = addEntry('A geteilt',  A, 'shared');
const bPriv   = addEntry('B privat',   B, 'private');
const aAmount = addEntry('A Skin',     A, 'shared_amount');

/** Liest sichtbare Einträge für viewer mit gegebenem Modus/Scope. */
function visibleIds(viewer, mode, scope) {
  let sql = `SELECT b.id FROM budget_entries b WHERE 1=1`;
  sql += ` AND ${budgetVisibilityWhere('b', '@me', { mode })}`;
  if (scope) sql += ` AND ${budgetScopeWhere(scope, 'b', '@me')}`;
  // node:sqlite lehnt unbenutzte benannte Parameter ab → nur binden, wenn referenziert.
  const params = sql.includes('@me') ? { me: viewer } : {};
  return db.prepare(sql).all(params).map(r => r.id);
}

/** Einträge, deren DETAILS viewer sehen darf (Zweck-Achse, z. B. Inventar). */
function detailIds(viewer, mode) {
  const sql = `SELECT b.id FROM budget_entries b WHERE ${budgetDetailsVisibleWhere('b', '@me', { mode })}`;
  const params = sql.includes('@me') ? { me: viewer } : {};
  return db.prepare(sql).all(params).map(r => r.id);
}

/** Summe, die viewer sieht - die Zahl, um die es in #659 ueberhaupt geht. */
function visibleSum(viewer, mode) {
  const sql = `SELECT COALESCE(SUM(b.amount), 0) AS total FROM budget_entries b
    WHERE ${budgetVisibilityWhere('b', '@me', { mode })}`;
  const params = sql.includes('@me') ? { me: viewer } : {};
  return db.prepare(sql).get(params).total;
}

test('personal-Modus: B sieht A privat NICHT, A geteilt schon', () => {
  const ids = visibleIds(B, 'personal');
  assert(!ids.includes(aPriv), 'B darf A privat nicht sehen');
  assert(ids.includes(aShared), 'B muss A geteilt sehen');
  assert(ids.includes(bPriv), 'B sieht eigenes privat');
});

test('personal-Modus: Admin sieht A privat AUCH NICHT (kein Bypass)', () => {
  const ids = visibleIds(ADMIN, 'personal');
  assert(!ids.includes(aPriv), 'Admin darf A privat nicht sehen');
  assert(!ids.includes(bPriv), 'Admin darf B privat nicht sehen');
  assert(ids.includes(aShared), 'Admin sieht geteilte Einträge');
});

test('shared-Modus: B sieht alles (Altverhalten)', () => {
  const ids = visibleIds(B, 'shared');
  assert(ids.includes(aPriv) && ids.includes(aShared) && ids.includes(bPriv), JSON.stringify(ids));
});

test('scope=mine: nur eigene Einträge von A', () => {
  const ids = visibleIds(A, 'personal', 'mine');
  assert(ids.includes(aPriv) && ids.includes(aShared), 'A sieht beide eigenen');
  assert(!ids.includes(bPriv), 'A sieht nicht B privat');
});

test('scope=household: nur der geteilte Topf', () => {
  const ids = visibleIds(A, 'personal', 'household');
  assert(ids.includes(aShared), 'geteilter Eintrag im Haushalt');
  assert(!ids.includes(aPriv) && !ids.includes(bPriv), 'keine privaten im Haushalt');
});

// ============================================================
// Dritte Stufe: Betrag zaehlt, Zweck bleibt privat (#659)
// ============================================================
console.log('\n[Budget-Visibility] shared_amount: die zwei Achsen\n');

test('B sieht den fremden shared_amount-Eintrag - das ist der Sinn der Stufe', () => {
  const ids = visibleIds(B, 'personal');
  assert(ids.includes(aAmount), 'Zeile muss da sein, sonst passt der Saldo nicht zur Liste');
  assert(!ids.includes(aPriv), 'echtes privat bleibt draussen');
});

test('B darf die DETAILS des shared_amount-Eintrags NICHT sehen', () => {
  const ids = detailIds(B, 'personal');
  assert(!ids.includes(aAmount), 'Zweck-Achse muss ihn ausschliessen');
  assert(ids.includes(aShared), 'echtes shared bleibt voll sichtbar');
});

test('A sieht die Details des eigenen shared_amount-Eintrags', () => {
  assert(detailIds(A, 'personal').includes(aAmount));
});

test('Admin bekommt keinen Bypass auf die Details', () => {
  assert(!detailIds(ADMIN, 'personal').includes(aAmount));
  assert(visibleIds(ADMIN, 'personal').includes(aAmount), 'aber der Betrag zaehlt auch fuer ihn');
});

test('der Betrag landet in der Summe fremder Betrachter', () => {
  // A: privat -10, geteilt -10, amount -10 → B sieht geteilt + amount + eigenes privat
  const withAmount = visibleSum(B, 'personal');
  const withoutAmount = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM budget_entries
    WHERE visibility = 'shared' OR owner_id = @me`).get({ me: B }).total;
  assert(withAmount === withoutAmount - 10,
    `Summe muss den fremden shared_amount enthalten: ${withAmount} vs ${withoutAmount}`);
});

test('scope=household enthaelt shared_amount, nicht aber privat', () => {
  const ids = visibleIds(A, 'personal', 'household');
  assert(ids.includes(aAmount), 'der Betrag gehoert in den gemeinsamen Topf');
  assert(!ids.includes(aPriv) && !ids.includes(bPriv), 'privates bleibt aussen vor');
});

test('shared-Modus: shared_amount verhaelt sich wie alles andere', () => {
  assert(visibleIds(B, 'shared').includes(aAmount));
  assert(detailIds(B, 'shared').includes(aAmount), 'im Altmodus wird nie maskiert');
});

test('die Kategorie-Aggregation verraet den Zweck nicht', () => {
  // Genau der Kanal, ueber den eine korrekte Summe den Zweck doch noch leakt.
  const rows = db.prepare(`
    SELECT CASE WHEN ${budgetDetailsHiddenWhere('b', '@me', { mode: 'personal' })}
                THEN '${BUDGET_MASKED_CATEGORY}' ELSE b.category END AS category,
           SUM(b.amount) AS total
    FROM budget_entries b
    WHERE ${budgetVisibilityWhere('b', '@me', { mode: 'personal' })}
    GROUP BY 1
  `).all({ me: B });
  const masked = rows.find((r) => r.category === BUDGET_MASKED_CATEGORY);
  assert(masked, 'fremder shared_amount braucht einen eigenen Sammel-Bucket');
  assert(masked.total === -10, `Betrag muss stimmen, war ${masked.total}`);
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  assert(total === visibleSum(B, 'personal'), 'Aufschluesselung muss die Gesamtsumme ergeben');
});

console.log(`\n[Budget-Visibility-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
