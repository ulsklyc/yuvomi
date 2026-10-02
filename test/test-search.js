/**
 * Modul: Such-Test (FTS5)
 * Zweck: Validiert die FTS5-Volltextsuche (Migration 44) und runSearch().
 *        Baut das Schema mit node:sqlite, prüft Migration + Trigger + Suchlogik.
 * Ausführen: node --experimental-sqlite test/test-search.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  runSearch, buildMatchQuery, runTableSearch, escapeLike, INFIX_TERM_CAP, searchExcerpt,
} from '../server/services/search.js';

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
// Migration 197: waste_types (only the table search reads from).
db.exec(MIGRATIONS_SQL[197]);
// Migration 206: FTS triggers + backfill for waste_types.
db.exec(MIGRATIONS_SQL[206]);

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

// Waste types: household-owned catalog, no owner filter (like contacts); archived excluded at query time.
db.prepare(`INSERT INTO waste_types (name, color) VALUES ('Cake-day recycling', '#22C55E')`).run();
db.prepare(`INSERT INTO waste_types (name, color, archived) VALUES ('Cake-day organic (retired)', '#A16207', 1)`).run();

test('Migration 44 legt FTS5-Tabelle und Trigger an, Backfill leer (Seed danach)', () => {
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'search_index'`).get();
  assert(tbl, 'search_index sollte existieren');
  const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_%'`).get();
  assert(triggers.n === 24, `Erwartet 24 Trigger (15 aus Mig. 44 + 6 aus Mig. 66 + 3 aus Mig. 199), erhalten ${triggers.n}`);
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
  assert(r.waste.some((w) => w.title === 'Cake-day recycling'), 'Abfall-Typ gefunden');
});

// AUSSCHNITT (Re-Critique 2026-09-28, A1 P2-2): ein Treffer, dessen Wort nicht
// im Titel steht, zeigte in der Palette nur Titel und Datum - "sch" fand
// "Klavier ueben" ohne Grund. Solche Zeilen tragen `excerpt`.
test('Treffer ausserhalb des Titels tragen einen Ausschnitt, Titeltreffer nicht', () => {
  const r = runSearch(db, 'sponge', uid);
  const cake = r.tasks.find((t) => t.title === 'Buy birthday cake');
  assert(cake, 'Aufgabe ueber die Beschreibung gefunden');
  assert(cake.excerpt === 'chocolate sponge', `Ausschnitt aus der Beschreibung erwartet, erhalten ${JSON.stringify(cake.excerpt)}`);
  assert(!('_body' in cake), 'das interne Feld _body darf nicht in die Antwort');
  const byTitle = runSearch(db, 'birthday', uid).tasks[0];
  assert(!('excerpt' in byTitle), 'ein Titeltreffer braucht keinen Ausschnitt');
  const note = runSearch(db, 'early', uid).notes.find((n) => n.title === 'Party');
  assert(note?.excerpt === 'order the cake early', `Notiz: ${JSON.stringify(note?.excerpt)}`);
  const ev = runSearch(db, 'flavor', uid).events.find((e) => e.title === 'Cake tasting');
  assert(ev?.excerpt === 'pick a flavor', `Termin: ${JSON.stringify(ev?.excerpt)}`);
  const act = runSearch(db, 'jog', uid).activities.find((a) => a.title === 'running');
  assert(act?.excerpt === 'morning jog', `Aktivitaet: ${JSON.stringify(act?.excerpt)}`);
});

test('searchExcerpt schneidet um die Fundstelle, an Wortgrenzen, mit Auslassung', () => {
  const long = 'Am Montag bringen wir die Noten fuer die Schule mit und danach geht es direkt weiter zum Klavierunterricht bei Frau Weber';
  const ex = searchExcerpt('schul', 'Klavier ueben', [long]);
  assert(ex && ex.includes('Schule'), `Fundstelle fehlt: ${ex}`);
  assert(ex.startsWith('\u2026') && ex.endsWith('\u2026'), `Auslassung an beiden Enden erwartet: ${ex}`);
  assert(!/^\u2026\S*[a-z]\S* /.test(ex) || long.includes(ex.slice(1, ex.indexOf(' '))), 'kein angeschnittenes Wort');
  // Akzente und ss wie der Index, der Ausschnitt zeigt den Originaltext.
  assert(searchExcerpt('grosse', 'Einkauf', ['eine große Tüte']) === 'eine große Tüte');
  assert(searchExcerpt('mull', 'Kontakt', ['Frau Müller']) === 'Frau Müller');
  // Steht alles im Titel, gibt es keinen Ausschnitt; fehlt ein Wort im Titel, zeigt der Ausschnitt dieses.
  assert(searchExcerpt('cake', 'Buy birthday cake', ['cake chocolate']) === null);
  assert(searchExcerpt('cake choc', 'Buy birthday cake', ['cake chocolate']) === 'cake chocolate');
  assert(searchExcerpt('xyz', 'Titel', ['nichts davon', null, '']) === null, 'kein Feld passt');
});

test('Suche findet Abfall-Typ über Namen, verbirgt archivierte Typen', () => {
  const r = runSearch(db, 'recycling', uid);
  const titles = r.waste.map((w) => w.title);
  assert(titles.includes('Cake-day recycling'), 'Aktiver Typ gefunden');
  assert(!titles.includes('Cake-day organic (retired)'), 'Archivierter Typ ausgeschlossen');
});

test('Abfall-Suchtrigger halten den Index synchron (UPDATE/DELETE)', () => {
  const t = db.prepare(`INSERT INTO waste_types (name, color) VALUES ('Renamewaste', '#000000')`).run();
  assert(runSearch(db, 'Renamewaste', uid).waste.length === 1, 'Neu angelegt gefunden');
  db.prepare(`UPDATE waste_types SET name = 'Renamedwaste' WHERE id = ?`).run(t.lastInsertRowid);
  assert(runSearch(db, 'Renamewaste', uid).waste.length === 0, 'Alter Name weg');
  assert(runSearch(db, 'Renamedwaste', uid).waste.length === 1, 'Neuer Name im Index');
  db.prepare(`DELETE FROM waste_types WHERE id = ?`).run(t.lastInsertRowid);
  assert(runSearch(db, 'Renamedwaste', uid).waste.length === 0, 'Nach DELETE nicht mehr im Index');
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

// #1607 (M4a): die globale Suche lieferte fuer eine Serie den Start der
// STAMMZEILE - ein Geburtstag von 1990 oeffnete den Kalender im Jahr 1990,
// waehrend die Kalendersuche dieselbe Serie laengst an ihrem naechsten Termin
// zeigte. Uhr und Zone stehen im Test: `todayKey` fragt beide.
// Die Suite baut ihr Schema aus einzelnen Migrationen; `sync_config` (Traeger
// der Haushaltszone) ist nicht dabei. Dieselbe Form wie in der Migration.
db.exec(`CREATE TABLE IF NOT EXISTS sync_config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
const searchModule = await import('../server/services/search.js');

function mitUhr(isoNow, zone, fn) {
  const Echt = globalThis.Date;
  const fest = new Echt(isoNow).getTime();
  class FesteUhr extends Echt {
    constructor(...args) { if (args.length) super(...args); else super(fest); }
    static now() { return fest; }
  }
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
  globalThis.Date = FesteUhr;
  // KEIN await zwischen Setzen und Zuruecksetzen.
  try { return fn(); } finally {
    globalThis.Date = Echt;
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
}

test('globale Suche zeigt eine alte Serie an ihrem naechsten Termin, nicht im Startjahr (#1607)', () => {
  const id = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, recurrence_rule, created_by)
    VALUES ('Geburtstag Qzxbirthday', '1990-10-14', 1, 'FREQ=YEARLY', ?)
  `).run(uid).lastInsertRowid;
  const treffer = mitUhr('2026-10-02T10:00:00Z', 'UTC', () => runSearch(db, 'Qzxbirthday', uid).events);
  assert(treffer.length === 1, `genau ein Treffer erwartet, bekommen ${treffer.length}`);
  assert(treffer[0].id === Number(id), 'der Treffer bleibt die Serie selbst');
  assert(treffer[0].start_datetime.slice(0, 10) === '2026-10-14',
    `erwartet den naechsten Termin 2026-10-14, bekommen ${treffer[0].start_datetime}`);
  assert(treffer[0].all_day === 1, 'ganztaegig bleibt ganztaegig');
});

test('"heute" der globalen Suche ist der Tag der Haushaltszone (#1607)', () => {
  // 00:30 UTC am 15.: in Los Angeles ist noch der 14., der Geburtstag also
  // heute; in UTC ist er vorbei und der naechste liegt ein Jahr spaeter. Die
  // beiden Antworten MUESSEN sich unterscheiden.
  const jetzt = '2026-10-15T00:30:00Z';
  const la = mitUhr(jetzt, 'America/Los_Angeles', () => runSearch(db, 'Qzxbirthday', uid).events[0]);
  const utc = mitUhr(jetzt, 'UTC', () => runSearch(db, 'Qzxbirthday', uid).events[0]);
  assert(la.start_datetime.slice(0, 10) === '2026-10-14', `Los Angeles: ${la.start_datetime}`);
  assert(utc.start_datetime.slice(0, 10) === '2027-10-14', `UTC: ${utc.start_datetime}`);
});

test('globale Suche und Kalendersuche fragen dasselbe Fenster ab (#1607)', () => {
  // Synchron, wie jeder Test dieser Datei: der eigene Zaehler wartet nicht.
  const { eventSearchWindow } = searchModule;
  assert(typeof eventSearchWindow === 'function', 'das gemeinsame Fenster fehlt');
  const fenster = mitUhr('2026-10-02T10:00:00Z', 'UTC', () => eventSearchWindow(db));
  assert(fenster.from === '2026-10-02' && fenster.to === '2028-10-01',
    `Fenster: ${JSON.stringify(fenster)}`);
  // UND BEIDE AUFRUFER NEHMEN ES: eine zweite Rechnung in der Route liefe beim
  // naechsten Umbau auseinander, und dieselbe Serie stuende wieder an zwei Tagen.
  const route = readFileSync(new URL('../server/routes/calendar/read.js', import.meta.url), 'utf8');
  assert(/eventSearchWindow\(/.test(route), 'die Kalendersuche rechnet ihr Fenster selbst');
  assert(!/shiftDateKey\(today, 730\)/.test(route), 'in der Route steht noch eine eigene Fensterrechnung');
});

test('die fuenf Treffer sind die fuenf fruehesten ANGEZEIGTEN Tage, nicht die fuenf aeltesten Stammzeilen (#1607)', () => {
  // Gedeckelt wurde nach dem Start der Stammzeile, angezeigt wird der naechste
  // Termin. Fuenf alte Serien, deren naechster Termin Monate entfernt liegt,
  // verdraengten so einen sechsten Treffer von morgen (Review an PR #1618).
  const ins = db.prepare(`INSERT INTO calendar_events (title, start_datetime, all_day, recurrence_rule, created_by)
                          VALUES (?, ?, 1, ?, ?)`);
  for (let i = 0; i < 5; i++) ins.run(`Jahrestag Qzxcrowd ${i}`, `198${i}-03-0${i + 1}`, 'FREQ=YEARLY', uid);
  ins.run('Morgen Qzxcrowd', '2026-10-03', null, uid);
  const treffer = mitUhr('2026-10-02T10:00:00Z', 'UTC', () => runSearch(db, 'Qzxcrowd', uid).events);
  assert(treffer.length === 5, `fuenf Treffer: ${treffer.length}`);
  assert(treffer[0].title === 'Morgen Qzxcrowd',
    `der Termin von morgen steht vorn: ${treffer.map((e) => `${e.title} ${e.start_datetime}`).join(' | ')}`);
  const tage = treffer.map((e) => e.start_datetime.slice(0, 10));
  assert(JSON.stringify(tage) === JSON.stringify([...tage].sort()), `aufsteigend: ${tage.join(', ')}`);
});

test('ohne kommenden Termin bleibt der Treffer die Stammzeile; ein Einzeltermin bleibt, wo er liegt (#1607)', () => {
  db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, recurrence_rule, created_by)
    VALUES ('Beendet Qzxended', '2001-03-05', 1, 'FREQ=YEARLY;UNTIL=20050305', ?),
           ('Einmal Qzxsingle', '1999-06-01T09:00:00', 0, NULL, ?)
  `).run(uid, uid);
  const beendet = mitUhr('2026-10-02T10:00:00Z', 'UTC', () => runSearch(db, 'Qzxended', uid).events[0]);
  assert(beendet.start_datetime.slice(0, 10) === '2001-03-05', `beendete Serie: ${beendet.start_datetime}`);
  const einmal = mitUhr('2026-10-02T10:00:00Z', 'UTC', () => runSearch(db, 'Qzxsingle', uid).events[0]);
  assert(einmal.start_datetime === '1999-06-01T09:00:00', `Einzeltermin: ${einmal.start_datetime}`);
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
    && r.meds.length === 0 && r.activities.length === 0 && r.waste.length === 0, 'Alles leer');
});

// --------------------------------------------------------------------------
// WORTTEILE (Re-Critique 2026-09-27, A1 P2-6): "Milch" fand die "Vollmilch"
// nicht - FTS5 kennt nur Praefixe. Die Abfrage holt sich jetzt aus dem
// Vokabular des Index die Woerter, die das Suchwort ENTHALTEN. Jeder Test
// prueft vorher, dass der reine Praefix NICHTS faende - sonst maesse er den
// alten Weg.
// --------------------------------------------------------------------------
db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
  VALUES ('Vollmilch holen', 'low', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
  VALUES ('Fremde Hafermilch', 'low', 'open', ?)`).run(otherUid);
db.prepare(`INSERT INTO shopping_items (list_id, name) VALUES (?, 'Tiefkühlerbsen')`).run(list.lastInsertRowid);
db.prepare(`INSERT INTO shopping_items (list_id, name) VALUES (?, 'Gießkanne')`).run(list.lastInsertRowid);

function prefixOnly(q, entity) {
  return db.prepare(`SELECT entity_id FROM search_index WHERE entity = ? AND search_index MATCH ?`)
    .all(entity, buildMatchQuery(q));
}

test('Wortteil: "milch" findet "Vollmilch" (Praefix allein findet nichts)', () => {
  assert(prefixOnly('milch', 'task').length === 0, 'Vorbedingung: der reine Praefix trifft nicht');
  const hits = runSearch(db, 'milch', uid).tasks.map((t) => t.title);
  assert(hits.includes('Vollmilch holen'), `Vollmilch fehlt: ${JSON.stringify(hits)}`);
});

test('Wortteil aendert keine Besitzerfilter: fremde "Hafermilch" bleibt verborgen', () => {
  const hits = runSearch(db, 'milch', uid).tasks.map((t) => t.title);
  assert(!hits.includes('Fremde Hafermilch'), 'die fremde Aufgabe kam ueber den Wortteil herein');
});

test('Wortteil faltet Akzente wie der Index: "kuhl" findet "Tiefkühlerbsen"', () => {
  assert(prefixOnly('kuhl', 'item').length === 0, 'Vorbedingung: der reine Praefix trifft nicht');
  assert(runSearch(db, 'kuhl', uid).items.some((i) => i.title === 'Tiefkühlerbsen'), 'Tiefkühlerbsen fehlt');
  assert(runSearch(db, 'KÜHL', uid).items.some((i) => i.title === 'Tiefkühlerbsen'), 'Grossschreibung mit Umlaut');
});

test('Wortteil kennt ß/ss: "iess" findet "Gießkanne"', () => {
  assert(prefixOnly('iess', 'item').length === 0, 'Vorbedingung: der reine Praefix trifft nicht');
  assert(runSearch(db, 'iess', uid).items.some((i) => i.title === 'Gießkanne'), 'Gießkanne fehlt');
});

test('Wortteil erst ab drei Zeichen: "lc" bleibt beim Praefix', () => {
  assert(!runSearch(db, 'lc', uid).tasks.some((t) => t.title === 'Vollmilch holen'),
    'zwei Buchstaben sollen nicht in jedes Wort greifen');
});

test('LIKE-Steuerzeichen sind Text: "il_h" trifft "Vollmilch" nicht, "%" ist kein Joker', () => {
  // Ungeflohen hiesse `_` "ein beliebiges Zeichen" - "%il_h%" traefe "milch".
  assert(!runSearch(db, 'il_h', uid).tasks.some((t) => t.title === 'Vollmilch holen'), '_ wirkte als Joker');
  assert(!runSearch(db, 'v%h', uid).tasks.some((t) => t.title === 'Vollmilch holen'), '% wirkte als Joker');
  assert(escapeLike('a_b%c\\') === 'a\\_b\\%c\\\\', `escapeLike: ${escapeLike('a_b%c\\')}`);
});

test('Wortteil ist gedeckelt: hoechstens INFIX_TERM_CAP zusaetzliche Woerter je Suchwort', () => {
  const ins = db.prepare(`INSERT INTO notes (title, content, created_by) VALUES (?, 'x', ?)`);
  for (let i = 0; i < INFIX_TERM_CAP + 10; i++) ins.run(`Zqwort${String(i).padStart(3, '0')}`, uid);
  const match = buildMatchQuery('qwort', { database: db });
  const branches = match.split(' OR ').length;
  assert(branches <= INFIX_TERM_CAP + 3, `${branches} Zweige, Deckel ${INFIX_TERM_CAP} + Praefixvarianten`);
  db.prepare("DELETE FROM notes WHERE title LIKE 'Zqwort%'").run();
});

// --------------------------------------------------------------------------
// TREFFERARTEN OHNE FTS-INDEX (runTableSearch): Rezepte, Vorrat, Inventar,
// Dokumente, Geburtstage, Budget. Gegen das ECHTE Schema (alle Migrationen),
// nicht gegen den Auszug in db-schema-test.js - die Sichtbarkeitsspalten von
// Dokumenten und Budget kamen spaet und stehen dort nicht.
// --------------------------------------------------------------------------
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'search-test-secret';
const { MIGRATIONS, get: getModuleDb } = await import('../server/db.js');
const { default: BetterSqlite } = await import('better-sqlite3-multiple-ciphers');
getModuleDb().close();
const full = new BetterSqlite(':memory:');
full.pragma('foreign_keys = ON');
full.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const m of MIGRATIONS) {
  if (typeof m.up === 'function') m.up(full); else full.exec(m.up);
  if (typeof m.afterUp === 'function') m.afterUp(full);
  full.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
}
const fa = full.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('fa', 'A', 'x', 'admin')`).run().lastInsertRowid;
const fb = full.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('fb', 'B', 'x', 'member')`).run().lastInsertRowid;

full.prepare('INSERT INTO recipes (title, notes, created_by) VALUES (?, ?, ?)').run('Omas Apfelkuchen', 'mit Zimt', fb);
full.prepare('INSERT INTO recipes (title, notes, created_by) VALUES (?, ?, ?)').run('Linsensuppe', 'Vollmilch statt Sahne', fb);
full.prepare('INSERT INTO pantry_items (name, quantity, unit) VALUES (?, 2, ?)').run('Gemüsebrühe', 'Glas');
full.prepare("INSERT INTO inventory_items (name, brand, status) VALUES ('Alte Bohrmaschine', 'Bosch', 'sold')").run();
full.prepare("INSERT INTO inventory_items (name, brand, status) VALUES ('Akku-Bohrmaschine', 'Makita', 'active')").run();
full.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)').run('Onkel Straßer', '1960-05-01', fb);
const insDoc = full.prepare(`INSERT INTO family_documents
  (name, original_name, mime_type, file_size, content_data, visibility, status, created_by)
  VALUES (?, 'a.pdf', 'application/pdf', 1, 'x', ?, ?, ?)`);
insDoc.run('Steuerbescheid familie', 'family', 'active', fb);
insDoc.run('Steuerbescheid privat fremd', 'private', 'active', fb);
const restricted = insDoc.run('Steuerbescheid freigegeben', 'restricted', 'active', fb).lastInsertRowid;
insDoc.run('Steuerbescheid restricted ohne mich', 'restricted', 'active', fb);
insDoc.run('Steuerbescheid archiviert', 'family', 'archived', fb);
full.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)').run(restricted, fa);
const insEntry = full.prepare(`INSERT INTO budget_entries (title, amount, date, created_by, owner_id, visibility)
  VALUES (?, -10, '2030-01-15', ?, ?, ?)`);
insEntry.run('Zahnarztrechnung geteilt', fb, fb, 'shared');
insEntry.run('Zahnarztrechnung privat fremd', fb, fb, 'private');
insEntry.run('Zahnarztrechnung betrag fremd', fb, fb, 'shared_amount');
insEntry.run('Zahnarztrechnung privat meins', fa, fa, 'private');

const titles = (rows) => rows.map((r) => r.title);

test('Tabellensuche: Wortteil im Titel und in der Notiz (Rezepte)', () => {
  assert(titles(runTableSearch(full, 'kuchen', fa).recipes).includes('Omas Apfelkuchen'), 'kuchen -> Apfelkuchen');
  assert(titles(runTableSearch(full, 'milch', fa).recipes).includes('Linsensuppe'), 'Notiz traegt den Wortteil');
  assert(titles(runTableSearch(full, 'omas kuchen', fa).recipes).length === 1, 'mehrere Woerter: UND');
  assert(runTableSearch(full, 'omas torte', fa).recipes.length === 0, 'ein fehlendes Wort -> kein Treffer');
});

test('Tabellensuche faltet Akzente und ß/ss wie der Index', () => {
  assert(titles(runTableSearch(full, 'bruhe', fa).pantry).includes('Gemüsebrühe'), 'bruhe -> Gemüsebrühe');
  assert(titles(runTableSearch(full, 'strasser', fa).birthdays).includes('Onkel Straßer'), 'strasser -> Straßer');
  assert(titles(runTableSearch(full, 'STRAß', fa).birthdays).includes('Onkel Straßer'), 'Grossschreibung mit ß');
});

test('Tabellensuche: LIKE-Zeichen bleiben Text', () => {
  assert(runTableSearch(full, 'k_chen', fa).recipes.length === 0, '_ ist kein Joker');
  assert(runTableSearch(full, 'k%n', fa).recipes.length === 0, '% ist kein Joker');
});

test('Tabellensuche: Inventar mit Marke, aktive Gegenstaende zuerst', () => {
  const hits = titles(runTableSearch(full, 'bohr', fa).inventory);
  assert(hits[0] === 'Akku-Bohrmaschine' && hits[1] === 'Alte Bohrmaschine', JSON.stringify(hits));
  assert(titles(runTableSearch(full, 'makita', fa).inventory).includes('Akku-Bohrmaschine'), 'Marke durchsucht');
});

test('Tabellensuche: Dokumente mit der Sichtbarkeit der Liste (eigen, Familie, freigegeben; nur aktiv)', () => {
  const hits = titles(runTableSearch(full, 'steuer', fa).documents).sort();
  assert(JSON.stringify(hits) === JSON.stringify(['Steuerbescheid familie', 'Steuerbescheid freigegeben']),
    `Dokumente: ${JSON.stringify(hits)}`);
});

test('Tabellensuche: Budget im gemeinsamen Modus findet jeden Titel', () => {
  full.prepare("DELETE FROM sync_config WHERE key = 'budget_mode'").run();
  assert(runTableSearch(full, 'zahnarzt', fa).budget.length === 4, 'shared-Modus: alle vier');
});

test('Tabellensuche: Budget im persoenlichen Modus nur, wo der Betrachter den ZWECK sieht', () => {
  full.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('budget_mode', 'personal')").run();
  try {
    const hits = titles(runTableSearch(full, 'zahnarzt', fa).budget).sort();
    assert(JSON.stringify(hits) === JSON.stringify(['Zahnarztrechnung geteilt', 'Zahnarztrechnung privat meins']),
      `Budget: ${JSON.stringify(hits)} - fremd privat und fremd "nur Betrag" duerfen nicht ueber den Titel auffindbar sein`);
  } finally {
    full.prepare("DELETE FROM sync_config WHERE key = 'budget_mode'").run();
  }
});

test('Tabellensuche deckelt bei SEARCH_LIMIT je Trefferart', () => {
  const ins = full.prepare('INSERT INTO pantry_items (name) VALUES (?)');
  for (let i = 0; i < 8; i++) ins.run(`Dosentomaten ${i}`);
  assert(runTableSearch(full, 'tomaten', fa).pantry.length === 5, 'fuenf je Art');
});

test('Tabellensuche: gesperrte Module und abgeschaltete Eintraege bleiben leer', () => {
  const r = runTableSearch(full, 'kuchen', fa, { hiddenModules: new Set(['meals']) });
  assert(r.recipes.length === 0, 'meals gesperrt -> keine Rezepte');
  const d = runTableSearch(full, 'strasser', fa, { disabledNav: new Set(['birthdays']) });
  assert(d.birthdays.length === 0, 'Geburtstage abgeschaltet');
});

full.close();

console.log(`\n[Search-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
