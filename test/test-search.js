/**
 * Modul: Such-Test (FTS5)
 * Zweck: Validiert die FTS5-Volltextsuche (Migration 44) und runSearch().
 *        Baut das Schema mit node:sqlite, prüft Migration + Trigger + Suchlogik.
 * Ausführen: node --experimental-sqlite test/test-search.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { runSearch, buildMatchQuery } from '../server/services/search.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

function assertCompactCalendarQueries(statements) {
  const calendarReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+calendar_events\b/i.test(sql));
  assert(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);
// Migration 44: FTS5 index + sync triggers. Must apply cleanly.
db.exec(MIGRATIONS_SQL[44]);
db.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions
db.exec(MIGRATIONS_SQL[27]); // legacy calendar attachment body
db.exec(MIGRATIONS_SQL[194]); // linked occurrence overrides
// Migration 65: health tables (medications, health_activities) the search reads from.
db.exec(MIGRATIONS_SQL[65]);
// Migration 66: FTS triggers + backfill for medications and health activities.
db.exec(MIGRATIONS_SQL[66]);

console.log('\n[Search-Test] FTS5-Volltextsuche\n');

const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('other', 'Other', 'x', 'member')`).run();
const otherUid = u2.lastInsertRowid;

// Seed rows AFTER migration so AFTER INSERT triggers populate the index.
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Buy birthday cake', 'chocolate sponge', 'high', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Mow the lawn', 'garden chores', 'low', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Secret cake plan', 'hidden', 'low', 'open', ?)`).run(otherUid);

const list = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('Groceries', ?)`).run(uid);
db.prepare(`INSERT INTO shopping_items (list_id, name) VALUES (?, 'cake mix')`).run(list.lastInsertRowid);

db.prepare(`INSERT INTO notes (title, content, created_by) VALUES ('Party', 'order the cake early', ?)`).run(uid);
db.prepare(`INSERT INTO contacts (name, phone, email) VALUES ('Cake Bakery', '555-1', 'hi@cake.test')`).run();
db.prepare(`INSERT INTO calendar_events (title, description, start_datetime, created_by)
  VALUES ('Cake tasting', 'pick a flavor', '2030-01-01T10:00:00Z', ?)`).run(uid);

// Sichtbarkeit in der globalen Suche (#474, Luecke aus dem #1055-Review): der
// Events-Bucket traegt dieselben zwei Klauseln wie die Kalender-Suche. Die
// Fixture braucht dafuer die Abo-Tabelle (Migration 10) und `subscription_id`;
// der CHECK auf external_source kennt in Migration 1 kein 'ics', deshalb wird
// er fuer die zwei Abo-Zeilen ausgesetzt - im echten Schema ist er erweitert.
db.exec(MIGRATIONS_SQL[10]);
db.exec('ALTER TABLE calendar_events ADD COLUMN subscription_id INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE;');
const insVisEvent = db.prepare(`INSERT INTO calendar_events
  (title, description, start_datetime, created_by, visibility, external_source, subscription_id)
  VALUES (?, ?, '2030-02-01T10:00:00Z', ?, ?, ?, ?)`);
insVisEvent.run('Cake secret private', 'hidden', otherUid, 'private', 'local', null);
const cakeAssignedToMe = insVisEvent.run('Cake assignees with me', 'shared with me', otherUid, 'assignees', 'local', null).lastInsertRowid;
db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(cakeAssignedToMe, uid);
insVisEvent.run('Cake assignees without me', 'not for me', otherUid, 'assignees', 'local', null);
insVisEvent.run('Cake own private', 'mine', uid, 'private', 'local', null);
const sharedSub = db.prepare(`INSERT INTO ics_subscriptions (name, url, shared, created_by)
  VALUES ('Shared feed', 'https://feed.test/shared.ics', 1, ?)`).run(otherUid).lastInsertRowid;
const privateSub = db.prepare(`INSERT INTO ics_subscriptions (name, url, shared, created_by)
  VALUES ('Private feed', 'https://feed.test/private.ics', 0, ?)`).run(otherUid).lastInsertRowid;
db.exec('PRAGMA ignore_check_constraints = ON;');
insVisEvent.run('Cake from shared feed', 'ics row', otherUid, 'all', 'ics', sharedSub);
insVisEvent.run('Cake from private feed', 'ics row', otherUid, 'all', 'ics', privateSub);
db.exec('PRAGMA ignore_check_constraints = OFF;');

// Health medications: own (private), foreign family-visible, foreign private.
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Aspirin', '500mg tablet', 'private')`).run(uid);
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Metformin', '850mg', 'family')`).run(otherUid);
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Warfarin', 'secret dose', 'private')`).run(otherUid);

// Health activities: own (private), foreign family-visible, foreign private.
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'running', '2030-01-01T08:00:00Z', 'morning jog', 'private')`).run(uid);
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'swimming', '2030-01-02T08:00:00Z', 'lap pool', 'family')`).run(otherUid);
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'boxing', '2030-01-03T08:00:00Z', 'private spar', 'private')`).run(otherUid);

test('Migration 44 legt FTS5-Tabelle und Trigger an, Backfill leer (Seed danach)', () => {
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'search_index'`).get();
  assert(tbl, 'search_index sollte existieren');
  const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_%'`).get();
  assert(triggers.n === 21, `Erwartet 21 Trigger (15 aus Mig. 44 + 6 aus Mig. 66), erhalten ${triggers.n}`);
});

test('buildMatchQuery erzeugt sichere Präfix-Phrasen, ignoriert Sonderzeichen', () => {
  assert(buildMatchQuery('cake') === '"cake"*', 'Einzeltoken als Präfix-Phrase');
  assert(buildMatchQuery('  ') === null, 'Leerzeichen -> null');
  assert(buildMatchQuery('a"b') === '"ab"*', 'Anführungszeichen/Sonderzeichen werden gesäubert');
  assert(buildMatchQuery('order the cake') === '"order"* AND "the"* AND "cake"*', 'Mehrere Tokens via AND');
});

test('Suche findet Aufgabe über Titel-Treffer (FTS MATCH)', () => {
  const r = runSearch(db, 'birthday', uid);
  assert(r.tasks.length === 1, `Erwartet 1 Task, erhalten ${r.tasks.length}`);
  assert(r.tasks[0].title === 'Buy birthday cake', 'Korrekte Aufgabe');
});

test('Suche respektiert Besitzer-Filter bei Aufgaben', () => {
  const r = runSearch(db, 'cake', uid);
  const titles = r.tasks.map((t) => t.title);
  assert(titles.includes('Buy birthday cake'), 'Eigene Aufgabe gefunden');
  assert(!titles.includes('Secret cake plan'), 'Fremde Aufgabe ausgeschlossen');
});

test('Suche deckt alle Entitäten ab', () => {
  const r = runSearch(db, 'cake', uid);
  assert(r.items.some((i) => i.title === 'cake mix'), 'Einkaufsartikel gefunden');
  assert(r.notes.some((n) => n.content.includes('cake')), 'Notiz gefunden');
  assert(r.contacts.some((c) => c.title === 'Cake Bakery'), 'Kontakt gefunden');
  assert(r.events.some((e) => e.title === 'Cake tasting'), 'Termin gefunden');
});

test('globale Suche liefert den aufgelösten verschobenen Termin mit Originalidentität', () => {
  const masterId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
    VALUES ('Global master', 'Current global description', '2030-07-01T09:00:00',
            '2030-07-01T10:00:00', 0, 'FREQ=DAILY;COUNT=3', ?)
  `).run(uid).lastInsertRowid;
  const childId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, recurrence_parent_id,
       recurrence_id, overridden_fields, created_by)
    VALUES ('Global override Qzxglobal', 'Stale global description',
            '2030-07-10T11:00:00', '2030-07-10T12:00:00', 1, ?, '2030-07-01',
            '["title","start_datetime","end_datetime"]', ?)
  `).run(masterId, uid).lastInsertRowid;
  db.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, '2030-07-01')
  `).run(masterId);

  const result = runSearch(db, 'Qzxglobal', uid).events;
  assert(result.length === 1, 'genau ein Treffer erwartet');
  assert(result[0].id === Number(childId), 'Child-ID fehlt');
  assert(result[0].all_day === 0, 'nicht überschriebenes all_day muss vom Master kommen');
  assert(result[0].start_datetime === '2030-07-10T11:00:00', 'verschobener Start fehlt');
  assert(result[0].series_id === Number(masterId), 'series_id fehlt');
  assert(result[0].recurrence_id === '2030-07-01', 'originale recurrence_id fehlt');
  assert(result[0].is_occurrence_override === true, 'Override-Kennzeichen fehlt');
});

test('globale Suche löst große Anhänge auf, ohne attachment_data zu lesen', () => {
  const largeAttachment = 'A'.repeat(1024 * 1024);
  const masterId = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, created_by, attachment_data)
    VALUES ('Attachment master', '2030-08-01T09:00:00', '2030-08-01T10:00:00',
            'FREQ=DAILY;COUNT=2', ?, ?)
  `).run(uid, largeAttachment).lastInsertRowid;
  const childId = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_parent_id, recurrence_id,
       overridden_fields, created_by, attachment_data)
    VALUES ('Qzxlargeattachment override', '2030-08-05T11:00:00', '2030-08-05T12:00:00',
            ?, '2030-08-01', '["title","start_datetime","end_datetime"]', ?, ?)
  `).run(masterId, uid, largeAttachment).lastInsertRowid;

  const originalPrepare = db.prepare.bind(db);
  const statements = [];
  db.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let result;
  try {
    result = runSearch(db, 'Qzxlargeattachment', uid).events;
  } finally {
    delete db.prepare;
  }

  assert(result.some((event) => Number(event.id) === Number(childId)), 'linked Treffer fehlt');
  assertCompactCalendarQueries(statements);
});

test('SQL guard erkennt e.* auch hinter einem calendar_events-JOIN', () => {
  let error;
  try {
    assertCompactCalendarQueries([
      'SELECT e.* FROM search_index si JOIN calendar_events e ON e.id = si.entity_id',
    ]);
  } catch (caught) {
    error = caught;
  }
  assert(error?.message.startsWith('Attachment-Body in kompakter Kalenderabfrage:'),
    `JOIN-Wildcard wurde nicht als Attachment-Body erkannt: ${error?.message || 'kein Fehler'}`);
});

test('Präfix-Treffer funktionieren (Teilwort)', () => {
  const r = runSearch(db, 'choc', uid);
  assert(r.tasks.some((t) => t.title === 'Buy birthday cake'), 'Beschreibung "chocolate" via Präfix');
});

test('UPDATE-Trigger hält den Index synchron', () => {
  const t = db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
    VALUES ('Renamewip', 'tmp', 'low', 'open', ?)`).run(uid);
  db.prepare(`UPDATE tasks SET title = 'Plumbing fix' WHERE id = ?`).run(t.lastInsertRowid);
  const before = runSearch(db, 'Renamewip', uid);
  assert(before.tasks.length === 0, 'Alter Titel nicht mehr im Index');
  const after = runSearch(db, 'Plumbing', uid);
  assert(after.tasks.some((x) => x.id === Number(t.lastInsertRowid)), 'Neuer Titel im Index');
});

test('DELETE-Trigger entfernt aus dem Index', () => {
  const t = db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
    VALUES ('Throwaway zebra', 'low', 'open', ?)`).run(uid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 1, 'Vorher gefunden');
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(t.lastInsertRowid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 0, 'Nachher nicht mehr gefunden');
});

test('Suche findet Medikament über Name (FTS MATCH)', () => {
  const r = runSearch(db, 'Aspirin', uid);
  assert(r.meds.length === 1, `Erwartet 1 Medikament, erhalten ${r.meds.length}`);
  assert(r.meds[0].title === 'Aspirin', 'Korrektes Medikament');
});

test('Suche findet Medikament über Dosistext (Präfix)', () => {
  const r = runSearch(db, 'tablet', uid);
  assert(r.meds.some((m) => m.title === 'Aspirin'), 'Dosistext "500mg tablet" via Treffer');
});

test('Suche findet Aktivität über Notiz und über Typ', () => {
  const byNote = runSearch(db, 'jog', uid);
  assert(byNote.activities.some((a) => a.note === 'morning jog'), 'Aktivität über Notiz gefunden');
  const byType = runSearch(db, 'running', uid);
  assert(byType.activities.some((a) => a.title === 'running'), 'Aktivität über Typ gefunden');
});

test('Health-Suche zeigt family-sichtbare Fremdzeilen', () => {
  const med = runSearch(db, 'Metformin', uid);
  assert(med.meds.some((m) => m.title === 'Metformin'), 'Fremdes family-Medikament sichtbar');
  const act = runSearch(db, 'swimming', uid);
  assert(act.activities.some((a) => a.title === 'swimming'), 'Fremde family-Aktivität sichtbar');
});

test('Health-Suche verbirgt fremde private Zeilen', () => {
  const med = runSearch(db, 'Warfarin', uid);
  assert(med.meds.length === 0, 'Fremdes privates Medikament ausgeschlossen');
  const act = runSearch(db, 'boxing', uid);
  assert(act.activities.length === 0, 'Fremde private Aktivität ausgeschlossen');
});

// --------------------------------------------------------
// Termine: Sichtbarkeit (#474) und Abo-Filter in der globalen Suche.
// Bis zum Review von #1055 hatte der Events-Bucket keine der beiden Klauseln,
// die die Kalender-Suche (routes/calendar/read.js) seit #474 traegt - jedes
// Mitglied fand Titel und Datum fremder PRIVATER Termine ueber ein Stichwort.
// --------------------------------------------------------

test('Termine: die globale Suche zeigt, was die Kalender-Suche zeigt - eigene, "all", mir zugewiesene, aus geteilten Abos', () => {
  const titles = runSearch(db, 'cake', uid).events.map((e) => e.title);
  for (const wanted of ['Cake tasting', 'Cake assignees with me', 'Cake own private', 'Cake from shared feed']) {
    assert(titles.includes(wanted), `${wanted} muss gefunden werden`);
  }
});

test('Termine: fremde private, fremd-zugewiesene und Termine aus fremden privaten Abos bleiben unsichtbar', () => {
  const titles = runSearch(db, 'cake', uid).events.map((e) => e.title);
  for (const hidden of ['Cake secret private', 'Cake assignees without me', 'Cake from private feed']) {
    assert(!titles.includes(hidden),
      `${hidden} darf NICHT gefunden werden - vorher fand jedes Mitglied Titel und Datum fremder privater Termine`);
  }
  // Der Ersteller selbst findet seine privaten Termine und sein eigenes Abo weiter.
  assert(runSearch(db, 'secret', otherUid).events.some((e) => e.title === 'Cake secret private'),
    'der Ersteller sieht seinen eigenen privaten Termin');
  const feeds = runSearch(db, 'feed', otherUid).events.map((e) => e.title);
  assert(feeds.includes('Cake from private feed') && feeds.includes('Cake from shared feed'),
    'der Abo-Besitzer sieht beide Abos');
  assert(!runSearch(db, 'feed', uid).events.some((e) => e.title === 'Cake from private feed'),
    'ein fremdes, nicht geteiltes Abo bleibt fuer andere unsichtbar');
});

test('Health-Suchtrigger halten den Index synchron (UPDATE/DELETE)', () => {
  const m = db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
    VALUES (?, 'Zolpidemtmp', 'x', 'private')`).run(uid);
  assert(runSearch(db, 'Zolpidemtmp', uid).meds.length === 1, 'Neu angelegt gefunden');
  db.prepare(`UPDATE medications SET name = 'Renamedmed' WHERE id = ?`).run(m.lastInsertRowid);
  assert(runSearch(db, 'Zolpidemtmp', uid).meds.length === 0, 'Alter Name weg');
  assert(runSearch(db, 'Renamedmed', uid).meds.length === 1, 'Neuer Name im Index');
  db.prepare(`DELETE FROM medications WHERE id = ?`).run(m.lastInsertRowid);
  assert(runSearch(db, 'Renamedmed', uid).meds.length === 0, 'Nach DELETE nicht mehr im Index');
});

test('Leere/kurze Query liefert leere Ergebnisse', () => {
  const r = runSearch(db, '', uid);
  assert(r.tasks.length === 0 && r.events.length === 0 && r.notes.length === 0
    && r.contacts.length === 0 && r.items.length === 0
    && r.meds.length === 0 && r.activities.length === 0, 'Alles leer');
});

console.log(`\n[Search-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
