/**
 * Modul: Budget - wiederkehrende Einträge (Intervall + virtuelles Budget) - Tests
 * Zweck: Validiert generateRecurringInstances für Einheit + Anzahl (#636:
 *        weekly/monthly/yearly, "alle N"), virtuelles (geglättetes) Budget,
 *        Idempotenz und übersprungene Fälligkeitstage.
 * Ausführen: node --experimental-sqlite test/test-budget-recurrence.js
 */

import { DatabaseSync } from 'node:sqlite';
import {
  generateRecurringInstances,
  occurrencesPerYear,
  occurrenceDatesInMonth,
  normalizeIntervalCount,
  effectiveMonthly,
} from '../server/routes/budget.js';
import { MIGRATIONS } from '../server/db.js';

// Die Serien-Definition (#1035) kommt aus der ECHTEN Migration, nicht aus einer
// Abschrift: ihre Trigger legen die Definition fuer jedes eingefuegte Original
// an, und eine Kopie davon wuerde hier genauso altern wie das Tabellenschema
// darunter (siehe Kommentar an visibility).
const SERIES_MIGRATION = MIGRATIONS.find((m) => m.description.includes('(#1035)'));

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
      recurrence_interval_count INTEGER NOT NULL DEFAULT 1,
      recurrence_virtual     INTEGER NOT NULL DEFAULT 0,
      recurrence_confirm     INTEGER NOT NULL DEFAULT 0,
      is_pending             INTEGER NOT NULL DEFAULT 0,
      recurrence_full_amount REAL,
      created_by             INTEGER NOT NULL,
      created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at             TEXT,
      owner_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
      account_id             INTEGER REFERENCES budget_accounts(id) ON DELETE SET NULL,
      -- Diese Tabelle ist von Hand nachgebaut und war an drei Stellen hinter dem
      -- echten Schema zurueck, als #973 sie brauchte: account_id und updated_at
      -- fehlten ganz, und der visibility-CHECK kannte shared_amount (Migration 156,
      -- #659) nicht. Eine Abschrift altert; wer hier eine Spalte ergaenzt, gleicht
      -- besser einmal gegen PRAGMA table_info(budget_entries) der echten DB ab.
      -- (Keine Backticks in diesem Block: er steht in einem Template-Literal.)
      visibility             TEXT    NOT NULL DEFAULT 'shared'
                                     CHECK (visibility IN ('private', 'shared', 'shared_amount'))
    );
    CREATE TABLE budget_accounts (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE budget_recurrence_skipped (
      parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      date      TEXT    NOT NULL,
      UNIQUE(parent_id, date)
    );
    -- Zustaendige je Buchung (#1057, Migration 191). Diese Suite baut ihr Schema
    -- von Hand statt ueber die Migrationen; generateRecurringInstances() vererbt
    -- die Zeilen an jede neue Instanz und braucht die Tabelle deshalb auch hier.
    CREATE TABLE budget_entry_responsibles (
      entry_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, user_id)
    );
    INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('admin', 'Admin', 'x', 'admin');
  `);
  db.exec(SERIES_MIGRATION.up);
  return db;
}

/** Legt ein Serien-Original an und gibt dessen id zurück. */
function insertParent(db, { amount, date, interval = 'monthly', count = 1, virtual = 0, full = null, confirm = 0, accountId = null }) {
  const r = db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring,
       recurrence_interval, recurrence_interval_count, recurrence_virtual,
       recurrence_confirm, recurrence_full_amount, created_by, account_id)
    VALUES ('Serie', ?, 'housing', 'utilities', ?, 1, ?, ?, ?, ?, ?, 1, ?)
  `).run(amount, date, interval, count, virtual, confirm, full, accountId);
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

test('occurrencesPerYear rechnet Einheit + Anzahl in eine Jahresfrequenz um', () => {
  assert(occurrencesPerYear('monthly') === 12);
  assert(occurrencesPerYear('monthly', 6) === 2, 'das frühere half_year');
  assert(occurrencesPerYear('yearly') === 1);
  assert(occurrencesPerYear('yearly', 2) === 0.5, 'alle zwei Jahre');
  assert(occurrencesPerYear('weekly') === 52);
  assert(occurrencesPerYear('weekly', 2) === 26, 'zweiwöchentlich');
  assert(occurrencesPerYear('unknown') === 12, 'Fallback auf monatlich');
});

test('normalizeIntervalCount hält die Anzahl in [1, 99]', () => {
  assert(normalizeIntervalCount(undefined) === 1);
  assert(normalizeIntervalCount(0) === 1);
  assert(normalizeIntervalCount(-3) === 1);
  assert(normalizeIntervalCount(2.7) === 2);
  assert(normalizeIntervalCount(500) === 99);
});

test('effectiveMonthly glättet den Periodenbetrag auf Monate', () => {
  assert(effectiveMonthly(-1200, 'yearly') === -100, `yearly: ${effectiveMonthly(-1200, 'yearly')}`);
  assert(effectiveMonthly(-600, 'monthly', 6) === -100, `alle 6 Monate: ${effectiveMonthly(-600, 'monthly', 6)}`);
  assert(effectiveMonthly(-100, 'monthly') === -100, `monthly: ${effectiveMonthly(-100, 'monthly')}`);
  // 52 Wochen / 12 Monate: 25 pro Woche sind 108,33 im Monat.
  assert(effectiveMonthly(-25, 'weekly') === -108.33, `weekly: ${effectiveMonthly(-25, 'weekly')}`);
  assert(effectiveMonthly(-2400, 'yearly', 2) === -100, `alle 2 Jahre: ${effectiveMonthly(-2400, 'yearly', 2)}`);
});

test('occurrenceDatesInMonth zählt Wochenserien im Monat auf', () => {
  // Start ist Freitag, der 2026-01-02; der März 2026 trägt vier davon.
  const march = occurrenceDatesInMonth('2026-01-02', 'weekly', 1, '2026-03');
  assert(march[0] === '2026-03-06', `erster Freitag: ${march[0]}`);
  assert(march.every((d) => d.startsWith('2026-03')), 'alle im Monat');
  assert(march.length === 4, `vier Freitage im März: ${march.join(', ')}`);
});

test('occurrenceDatesInMonth: alle zwei Wochen überspringt jede zweite', () => {
  const dates = occurrenceDatesInMonth('2026-01-02', 'weekly', 2, '2026-03');
  assert(dates.length === 2, `zwei Termine im März: ${dates.join(', ')}`);
  assert(dates[0] === '2026-03-13' && dates[1] === '2026-03-27', dates.join(', '));
});

test('occurrenceDatesInMonth: der Starttag selbst zählt nicht mit', () => {
  assert(occurrenceDatesInMonth('2026-01-02', 'weekly', 1, '2026-01')[0] === '2026-01-09');
  assert(occurrenceDatesInMonth('2026-01-15', 'monthly', 1, '2026-01').length === 0);
});

test('occurrenceDatesInMonth kappt den Monatsüberlauf', () => {
  assert(occurrenceDatesInMonth('2026-01-31', 'monthly', 1, '2026-02')[0] === '2026-02-28');
  assert(occurrenceDatesInMonth('2026-01-31', 'monthly', 1, '2026-04')[0] === '2026-04-30');
  assert(occurrenceDatesInMonth('2026-01-31', 'monthly', 1, '2026-03')[0] === '2026-03-31');
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

test('Alle 6 Monate erzeugt halbjährlich (das frühere half_year)', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -600, date: '2026-01-10', interval: 'monthly', count: 6 });
  generateRecurringInstances(db, '2026-04'); // diff 3 → kein Treffer
  assert(!instanceIn(db, pid, '2026-04'), 'April ohne Instanz');
  generateRecurringInstances(db, '2026-07'); // diff 6 → Treffer
  const inst = instanceIn(db, pid, '2026-07');
  assert(inst && inst.amount === -600, 'Juli hat vollen Betrag');
});

test('Wöchentlich erzeugt mehrere Instanzen im selben Monat', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -25, date: '2026-01-02', interval: 'weekly' });
  generateRecurringInstances(db, '2026-03');
  const inMarch = instances(db, pid).filter((e) => e.date.startsWith('2026-03'));
  assert(inMarch.length === 4, `vier Wochen-Instanzen, erhalten ${inMarch.length}`);
  assert(inMarch.every((e) => e.amount === -25), 'jede trägt den vollen Wochenbetrag');
  assert(inMarch[0].date === '2026-03-06', `erste am ${inMarch[0].date}`);
});

test('Alle 2 Wochen lässt jede zweite Woche aus', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -40, date: '2026-01-02', interval: 'weekly', count: 2 });
  generateRecurringInstances(db, '2026-03');
  const dates = instances(db, pid).map((e) => e.date);
  assert(dates.join(',') === '2026-03-13,2026-03-27', dates.join(','));
});

test('Alle 2 Jahre erzeugt nur im zweiten Jahrestag-Monat', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -300, date: '2026-01-15', interval: 'yearly', count: 2 });
  generateRecurringInstances(db, '2027-01');
  assert(!instanceIn(db, pid, '2027-01'), 'nach einem Jahr noch nicht fällig');
  generateRecurringInstances(db, '2028-01');
  assert(instanceIn(db, pid, '2028-01'), 'nach zwei Jahren fällig');
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

test('Virtuell alle 6 Monate erzeugt auch in Nicht-Fälligkeitsmonaten', () => {
  const db = freshDb();
  const pid = insertParent(db, {
    amount: -100, date: '2026-01-10', interval: 'monthly', count: 6, virtual: 1, full: -600,
  });
  generateRecurringInstances(db, '2026-03'); // bei nicht-virtuell wäre das leer
  const inst = instanceIn(db, pid, '2026-03');
  assert(inst && inst.amount === -100, 'März hat geglätteten Anteil');
});

test('Virtuell wöchentlich bleibt bei EINER Buchung je Monat', () => {
  // Der Monatsanteil ist eine Planungsgröße: über den Monat verstreute
  // Teilbeträge wären keine Zahlungen, sondern Bruchstücke einer Schätzung.
  const db = freshDb();
  const pid = insertParent(db, {
    amount: -108.33, date: '2026-01-02', interval: 'weekly', virtual: 1, full: -25,
  });
  generateRecurringInstances(db, '2026-03');
  const inMarch = instances(db, pid).filter((e) => e.date.startsWith('2026-03'));
  assert(inMarch.length === 1, `genau eine Instanz, erhalten ${inMarch.length}`);
  assert(inMarch[0].amount === -108.33, `Monatsanteil: ${inMarch[0].amount}`);
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

test('Übersprungener Fälligkeitstag erzeugt keine Instanz', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)').run(pid, '2026-03-15');
  generateRecurringInstances(db, '2026-03');
  assert(!instanceIn(db, pid, '2026-03'), 'März bleibt leer (übersprungen)');
});

test('Ein übersprungener Termin nimmt die übrigen Wochen nicht mit', () => {
  // Genau das war der Grund, den Vermerk vom Monat auf den Tag zu ziehen (#636):
  // eine gelöschte Woche hätte sonst den ganzen Monat stillgelegt.
  const db = freshDb();
  const pid = insertParent(db, { amount: -25, date: '2026-01-02', interval: 'weekly' });
  db.prepare('INSERT INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)').run(pid, '2026-03-13');
  generateRecurringInstances(db, '2026-03');
  const dates = instances(db, pid).map((e) => e.date);
  assert(dates.join(',') === '2026-03-06,2026-03-20,2026-03-27', dates.join(','));
});

test('Startmonat selbst bekommt keine zusätzliche Instanz', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -950, date: '2026-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2026-01');
  assert(!instanceIn(db, pid, '2026-01'), 'Startmonat ohne Kind-Instanz');
});

// --------------------------------------------------------
// Bestätigung vor der Buchung (#637)
// --------------------------------------------------------

test('Eine Serie mit Bestätigungspflicht erzeugt erwartete Buchungen', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -60, date: '2026-01-15', interval: 'monthly', confirm: 1 });
  generateRecurringInstances(db, '2026-03');
  const inst = instanceIn(db, pid, '2026-03');
  assert(inst, 'Instanz vorhanden');
  assert(inst.is_pending === 1, 'als erwartet markiert');
});

test('Ohne Bestätigungspflicht bleibt die Buchung sofort gültig', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -60, date: '2026-01-15', interval: 'monthly' });
  generateRecurringInstances(db, '2026-03');
  assert(instanceIn(db, pid, '2026-03').is_pending === 0, 'Vorgabe bleibt gebucht');
});

test('Auch jede Woche einer bestätigungspflichtigen Serie wartet einzeln', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -25, date: '2026-01-02', interval: 'weekly', confirm: 1 });
  generateRecurringInstances(db, '2026-03');
  const all = instances(db, pid);
  assert(all.length === 4, `vier Instanzen, erhalten ${all.length}`);
  assert(all.every((e) => e.is_pending === 1), 'jede einzeln zu bestätigen');
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
// Konto der Serie (#973)
//
// Eine Dauerlastschrift geht jeden Monat vom selben Konto ab. Die Instanz erbt
// dieselben Felder wie Eigentuemer und Sichtbarkeit; das Konto fehlte in dieser
// Liste, und der Fehler war unauffaellig, weil nur die ERSTE Buchung von Hand
// entsteht und ihr Konto also stimmt. Der Test prueft deshalb den zweiten und
// dritten Monat, nicht den ersten.
// --------------------------------------------------------

test('Instanz erbt das Konto der Serie', () => {
  const db = freshDb();
  db.prepare('INSERT INTO budget_accounts (id, name) VALUES (9, ?)').run('Girokonto');
  const pid = insertParent(db, { amount: -90000, date: '2026-08-05', accountId: 9 });

  generateRecurringInstances(db, '2026-09');
  generateRecurringInstances(db, '2026-10');

  for (const month of ['2026-09', '2026-10']) {
    const inst = instanceIn(db, pid, month);
    assert(inst, `Instanz fuer ${month} vorhanden`);
    assert(inst.account_id === 9,
      `Instanz ${month} muss das Konto der Serie tragen, war ${inst.account_id}`);
  }
});

test('Instanz erbt die Zustaendigen der Serie - auch die virtuelle', () => {
  // Anders als das Konto (das eine virtuelle Serie NICHT vererbt, weil ihre
  // Instanzen Planwerte sind und einen Saldo verfaelschen wuerden) bewegt die
  // Zustaendigkeit kein Geld: sie gilt am Planwert genauso wie an der Zahlung.
  for (const virtual of [0, 1]) {
    const db = freshDb();
    const pid = insertParent(db, { amount: -90000, date: '2026-08-05', virtual, full: virtual ? -90000 : null });
    // Die Zustaendigen der SERIE stehen seit #1035 in ihrer Definition; die
    // des Originals beschreiben nur dessen eigene Buchung.
    db.prepare('INSERT INTO budget_series_responsibles (anchor_id, user_id) VALUES (?, 1)').run(pid);

    generateRecurringInstances(db, '2026-09');

    const inst = instanceIn(db, pid, '2026-09');
    assert(inst, `Instanz vorhanden (virtual=${virtual})`);
    const who = db.prepare('SELECT user_id FROM budget_entry_responsibles WHERE entry_id = ?').all(inst.id);
    assert(who.length === 1 && who[0].user_id === 1,
      `Instanz muss die zustaendige Person der Serie erben (virtual=${virtual}), war ${JSON.stringify(who)}`);
  }
});

test('Eine Serie ohne Zustaendige vererbt keine', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -1000, date: '2026-08-05' });
  generateRecurringInstances(db, '2026-09');
  const inst = instanceIn(db, pid, '2026-09');
  const who = db.prepare('SELECT user_id FROM budget_entry_responsibles WHERE entry_id = ?').all(inst.id);
  assert(who.length === 0, `keine Zustaendigen erwartet, waren ${who.length}`);
});

test('Serie ohne Konto vererbt keines', () => {
  const db = freshDb();
  const pid = insertParent(db, { amount: -1000, date: '2026-08-05' });
  generateRecurringInstances(db, '2026-09');
  const inst = instanceIn(db, pid, '2026-09');
  assert(inst, 'Instanz vorhanden');
  assert(inst.account_id === null,
    `Ohne Konto an der Serie bleibt die Instanz kontolos, war ${inst.account_id}`);
});

test('Virtuelle Serie vererbt das Konto NICHT', () => {
  // Umgekehrt zum Rest, und der Grund ist der Kontosaldo. Die Instanzen einer
  // virtuellen Serie sind Planwerte: 12000 im Jahr stehen als 1000 je Monat,
  // waehrend die Bank einmal 12000 abbucht. `listAccounts()` summiert jeden
  // nicht-erwarteten Eintrag mit Konto in den Saldo, und die Instanz traegt
  // kein eigenes `recurrence_virtual` - die Abfrage koennte einen Planwert also
  // gar nicht aussortieren. Mit Konto wanderte der Saldo Monat fuer Monat,
  // ohne dass etwas abgebucht wurde (gemessen: -800 nach acht Monaten).
  const db = freshDb();
  db.prepare('INSERT INTO budget_accounts (id, name) VALUES (4, ?)').run('Sparkonto');
  const pid = insertParent(db, {
    amount: -1000, date: '2026-08-05', interval: 'yearly', virtual: 1, full: -12000, accountId: 4,
  });
  generateRecurringInstances(db, '2026-09');
  const inst = instanceIn(db, pid, '2026-09');
  assert(inst, 'Virtuelle Instanz vorhanden');
  assert(inst.account_id === null,
    `Ein geglaetteter Planwert darf keinen Kontosaldo bewegen, war ${inst.account_id}`);
  // Das Original behaelt seines: es ist die von Hand angelegte Buchung.
  const orig = db.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(pid);
  assert(orig.account_id === 4, 'die Serie selbst behaelt ihr Konto');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Budget-Recurrence-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
