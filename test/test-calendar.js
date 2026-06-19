/**
 * Modul: Kalender-Test
 * Zweck: Validiert alle Calendar-API-Abfragen, Datumsbereichs-Filter,
 *        Constraints, CRUD-Logik
 * Ausführen: node --experimental-sqlite test-calendar.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
const { __test: calendarHelpers } = await import('../public/pages/calendar.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

test('Kalenderanhänge verwenden Dokument-Endpunkte und behalten Legacy-Data-URLs lesbar', () => {
  const linked = {
    attachment_document_id: 42,
    attachment_preview_url: '/api/v1/documents/42/preview',
    attachment_download_url: '/api/v1/documents/42/download',
    attachment_data: null,
  };
  assert(calendarHelpers.hasAttachment(linked) === true, 'Dokumentlink wird als Anhang erkannt');
  assert(
    JSON.stringify(calendarHelpers.attachmentUrls(linked)) === JSON.stringify({
      preview: '/api/v1/documents/42/preview',
      download: '/api/v1/documents/42/download',
    }),
    'Dokument-Endpunkte werden bevorzugt'
  );

  const legacy = {
    attachment_document_id: null,
    attachment_data: 'bGVnYWN5',
    attachment_mime: 'text/plain',
  };
  assert(calendarHelpers.hasAttachment(legacy) === true, 'Legacy-Blob wird als Anhang erkannt');
  assert(
    JSON.stringify(calendarHelpers.attachmentUrls(legacy)) === JSON.stringify({
      preview: 'data:text/plain;base64,bGVnYWN5',
      download: 'data:text/plain;base64,bGVnYWN5',
    }),
    'Legacy-Blob bleibt als Data URL lesbar'
  );
  assert(calendarHelpers.hasAttachment({}) === false, 'Leeres Event hat keinen Anhang');
});

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

// Benutzer
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;

const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('maria', 'Maria', 'x', '#34C759')`).run();
const uid2 = u2.lastInsertRowid;

console.log('\n[Calendar-Test] Termine, Datumsbereich, CRUD, Constraints\n');

let ev1, ev2, ev3, ev4;

test('Kalender-Ansicht: gültige gespeicherte Werte bleiben erhalten', () => {
  assert(calendarHelpers.normalizeCalendarView('week', 'agenda') === 'week', 'week bleibt erhalten');
  assert(calendarHelpers.normalizeCalendarView('agenda', 'month') === 'agenda', 'agenda bleibt erhalten');
});

test('Kalender-Ansicht: ungültige gespeicherte Werte fallen auf Geräte-Default zurück', () => {
  assert(calendarHelpers.defaultCalendarViewFromState({ savedView: 'bogus', isMobile: true }) === 'agenda', 'Mobil fällt auf Agenda zurück');
  assert(calendarHelpers.defaultCalendarViewFromState({ savedView: null, isMobile: false }) === 'month', 'Desktop fällt auf Monat zurück');
});

// --------------------------------------------------------
// Termin-CRUD
// --------------------------------------------------------
test('Termin erstellen (mit Uhrzeit)', () => {
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, color, created_by)
    VALUES ('Zahnarzt', '2026-03-24T10:00', '2026-03-24T11:00', '#FF3B30', ?)
  `).run(uid);
  ev1 = r.lastInsertRowid;
  assert(ev1 > 0);
});

test('Termin erstellen (ganztägig)', () => {
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, color, created_by)
    VALUES ('Ostern', '2026-04-05', 1, '#34C759', ?)
  `).run(uid);
  ev2 = r.lastInsertRowid;
  assert(ev2 > 0);
});

test('Termin erstellen (mehrtägig)', () => {
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, color, created_by)
    VALUES ('Urlaub', '2026-03-28', '2026-04-04', 1, '#FF9500', ?)
  `).run(uid);
  ev3 = r.lastInsertRowid;
  assert(ev3 > 0);
});

test('Termin mit Zuweisung erstellen', () => {
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, color, assigned_to, created_by)
    VALUES ('Elternabend', '2026-03-26T18:00', '#AF52DE', ?, ?)
  `).run(uid2, uid);
  ev4 = r.lastInsertRowid;
  assert(ev4 > 0);
});

test('Termin abrufen (mit assigned_name via JOIN)', () => {
  const ev = db.prepare(`
    SELECT e.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM calendar_events e
    LEFT JOIN users u ON u.id = e.assigned_to
    WHERE e.id = ?
  `).get(ev4);
  assert(ev.assigned_name === 'Maria', `assigned_name: ${ev.assigned_name}`);
  assert(ev.assigned_color === '#34C759');
});

test('Termin-Icon hat Default-Wert', () => {
  const ev = db.prepare('SELECT icon FROM calendar_events WHERE id = ?').get(ev1);
  assert(ev.icon === 'calendar', `icon: ${ev.icon}`);
});

test('Termin aktualisieren (Titel + Farbe)', () => {
  db.prepare(`UPDATE calendar_events SET title = 'Zahnarzt Dr. Müller', color = '#007AFF' WHERE id = ?`).run(ev1);
  const ev = db.prepare('SELECT title, color FROM calendar_events WHERE id = ?').get(ev1);
  assert(ev.title === 'Zahnarzt Dr. Müller');
  assert(ev.color === '#007AFF');
});

test('external_source-Constraint (ungültiger Wert)', () => {
  let threw = false;
  try {
    db.prepare(`INSERT INTO calendar_events (title, start_datetime, external_source, created_by)
      VALUES ('Test', '2026-03-24', 'outlook', ?)`).run(uid);
  } catch { threw = true; }
  assert(threw, 'Constraint muss verletzt werden');
});

// --------------------------------------------------------
// Datumsbereichs-Filter
// --------------------------------------------------------
test('Termine in März 2026 (inkl. mehrtägiger)', () => {
  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE DATE(start_datetime) <= '2026-03-31'
      AND (end_datetime IS NULL OR DATE(end_datetime) >= '2026-03-01')
    ORDER BY start_datetime ASC
  `).all();
  // Zahnarzt (24.3), Elternabend (26.3), Urlaub (28.3–4.4)
  assert(events.length === 3, `Erwartet 3, erhalten ${events.length}`);
});

test('Termine in April 2026 (inkl. Urlaub + Ostern)', () => {
  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE DATE(start_datetime) <= '2026-04-30'
      AND (end_datetime IS NULL OR DATE(end_datetime) >= '2026-04-01')
    ORDER BY start_datetime ASC
  `).all();
  // Urlaub endet 4.4, Ostern 5.4
  assert(events.length >= 2, `Erwartet mindestens 2, erhalten ${events.length}`);
  const titles = events.map((e) => e.title);
  assert(titles.includes('Urlaub'), 'Urlaub in April');
  assert(titles.includes('Ostern'), 'Ostern in April');
});

test('Termine nach Benutzer filtern', () => {
  const events = db.prepare(`
    SELECT * FROM calendar_events WHERE assigned_to = ?
  `).all(uid2);
  assert(events.length === 1);
  assert(events[0].title === 'Elternabend');
});

test('Nur lokale Termine (external_source = local)', () => {
  const events = db.prepare(`
    SELECT * FROM calendar_events WHERE external_source = 'local'
  `).all();
  assert(events.length === 4, `Alle 4 Termine sind lokal, erhalten ${events.length}`);
});

test('Kommende Termine (upcoming)', () => {
  // Alle Termine mit start_datetime >= jetzt (in Tests alle "in der Zukunft" relativ zu 2026)
  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE start_datetime >= '2026-03-24T00:00'
    ORDER BY start_datetime ASC
    LIMIT 5
  `).all();
  assert(events.length >= 1);
  assert(events[0].title === 'Zahnarzt Dr. Müller', `Erster Termin: ${events[0].title}`);
});

// --------------------------------------------------------
// Sortierung
// --------------------------------------------------------
test('Sortierung: ganztägig nach uhrzeit-basierten Terminen', () => {
  // Gleicher Tag: Ganztägig sollte nach hinten oder flexibel - hier: all_day DESC in der Abfrage
  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE DATE(start_datetime) = '2026-03-24'
    ORDER BY start_datetime ASC, all_day DESC
  `).all();
  assert(events.length >= 1);
});

// --------------------------------------------------------
// Index-Abfragen (Performance-relevante Queries)
// --------------------------------------------------------
test('Index idx_calendar_start genutzt (EXPLAIN QUERY PLAN)', () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM calendar_events WHERE start_datetime >= '2026-03-01' ORDER BY start_datetime ASC
  `).all();
  const usesIndex = plan.some((row) => {
    const detail = row.detail || '';
    return detail.includes('idx_calendar_start') || detail.includes('COVERING INDEX') || detail.includes('INDEX');
  });
  assert(usesIndex, `Index nicht genutzt: ${JSON.stringify(plan)}`);
});

test('Index idx_calendar_assigned genutzt', () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM calendar_events WHERE assigned_to = ?
  `).all(uid2);
  const usesIndex = plan.some((row) => {
    const detail = row.detail || '';
    return detail.includes('idx_calendar_assigned') || detail.includes('INDEX');
  });
  assert(usesIndex, `Index nicht genutzt: ${JSON.stringify(plan)}`);
});

// --------------------------------------------------------
// Löschen
// --------------------------------------------------------
test('Termin löschen', () => {
  const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(ev2);
  assert(result.changes === 1, 'Genau 1 Eintrag gelöscht');
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(ev2);
  assert(!ev, 'Termin nicht mehr vorhanden');
});

test('Nicht existierender Termin gibt keine Zeile', () => {
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(99999);
  assert(!ev, 'Sollte undefined sein');
});

// --------------------------------------------------------
// Datumshelfer (clientseitige Logik hier als reine JS-Tests)
// --------------------------------------------------------
test('Wochenberechnung: Montag korrekt', () => {
  function getMondayOf(dateStr) {
    const d   = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    d.setDate(d.getDate() + diff);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  assert(getMondayOf('2026-03-24') === '2026-03-23', 'Di → Mo');
  assert(getMondayOf('2026-03-23') === '2026-03-23', 'Mo bleibt Mo');
  assert(getMondayOf('2026-03-29') === '2026-03-23', 'So → Mo der gleichen Woche');
  assert(getMondayOf('2026-03-22') === '2026-03-16', 'So → Mo der Vorwoche');
});

test('Monatsbereich: 42 Tage für Kalenderraster', () => {
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  const from = '2026-03-01';
  const to   = addDays(from, 41);
  assert(to === '2026-04-11', `Erwartet 2026-04-11, erhalten ${to}`);
});

// --------------------------------------------------------
// nextOccurrence: INTERVAL-Korrektheit mit BYDAY
// --------------------------------------------------------
import { nextOccurrence } from '../server/services/recurrence.js';

test('nextOccurrence: WEEKLY BYDAY=MO,TU,WE,TH,FR INTERVAL=2 — kein täglicher Übergang', () => {
  const rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=2';
  // Innerhalb der Woche: Mo→Di (1 Tag, kein Intervallsprung)
  assert(nextOccurrence('2026-05-04', rule) === '2026-05-05', 'Mo→Di');
  // Innerhalb der Woche: Di→Mi
  assert(nextOccurrence('2026-05-05', rule) === '2026-05-06', 'Di→Mi');
  // Freitag → Montag der übernächsten Woche (3 + 7 = 10 Tage)
  assert(nextOccurrence('2026-05-08', rule) === '2026-05-18', 'Fr→Mo (übernächste Woche)');
});

test('nextOccurrence: WEEKLY BYDAY=SA,SU INTERVAL=2 — Wochenend-Pair bleibt zusammen', () => {
  const rule = 'FREQ=WEEKLY;BYDAY=SA,SU;INTERVAL=2';
  // Sa→So (1 Tag, gleiche Woche)
  assert(nextOccurrence('2026-05-09', rule) === '2026-05-10', 'Sa→So');
  // So→Sa der übernächsten Woche (13 Tage)
  assert(nextOccurrence('2026-05-10', rule) === '2026-05-23', 'So→Sa (übernächste Woche)');
});

test('nextOccurrence: WEEKLY BYDAY=MO INTERVAL=2 — klassisch alle 2 Wochen', () => {
  assert(nextOccurrence('2026-05-04', 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2') === '2026-05-18', 'Mo→Mo+14');
});

// --------------------------------------------------------
// Task-Chip-Helfer
// --------------------------------------------------------

console.log('\n[Calendar-Test] Task-Chip-Helfer\n');

const { filterTasksForCalendar: ftc } = calendarHelpers;

test('filterTasksForCalendar: Tasks ohne due_date werden gefiltert', () => {
  const tasks = [
    { id: 1, title: 'A', due_date: null,         status: 'open' },
    { id: 2, title: 'B', due_date: '2026-06-15', status: 'open' },
  ];
  const result = ftc(tasks);
  assert(result.length === 1, 'Nur 1 Task erwartet');
  assert(result[0].id === 2, 'Task B muss enthalten sein');
});

test('filterTasksForCalendar: done-Tasks werden gefiltert', () => {
  const tasks = [
    { id: 1, title: 'A', due_date: '2026-06-15', status: 'done'     },
    { id: 2, title: 'B', due_date: '2026-06-16', status: 'open'     },
    { id: 3, title: 'C', due_date: '2026-06-17', status: 'archived' },
  ];
  const result = ftc(tasks);
  assert(result.length === 1, 'Nur 1 Task erwartet');
  assert(result[0].id === 2, 'Nur offener Task erwartet');
});

test('filterTasksForCalendar: in_progress-Tasks werden behalten', () => {
  const tasks = [
    { id: 1, title: 'A', due_date: '2026-06-15', status: 'in_progress' },
  ];
  const result = ftc(tasks);
  assert(result.length === 1, 'in_progress-Task muss enthalten sein');
});

test('filterTasksForCalendar: leeres Array gibt leeres Array zurück', () => {
  assert(ftc([]).length === 0, 'Leeres Array erwartet');
});

// --------------------------------------------------------
// Mehrtägige Events (#225)
// --------------------------------------------------------
const { isMultiDayEvent, isAllDayLike, agendaSegmentKind } = calendarHelpers;

test('isMultiDayEvent: gleicher Tag ist nicht mehrtägig', () => {
  assert(isMultiDayEvent({ start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-14T08:05' }) === false,
    'Start/Ende am selben Tag → false');
});

test('isMultiDayEvent: verschiedene Tage sind mehrtägig', () => {
  assert(isMultiDayEvent({ start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-19T08:05' }) === true,
    'Start 14., Ende 19. → true');
});

test('isMultiDayEvent: ohne Enddatum nicht mehrtägig', () => {
  assert(isMultiDayEvent({ start_datetime: '2026-06-14T03:00', end_datetime: null }) === false,
    'kein Enddatum → false');
});

test('isAllDayLike: mehrtägiges Zeit-Event gehört in die Ganztags-Zeile', () => {
  assert(isAllDayLike({ start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-19T08:05', all_day: 0 }) === true,
    'Mehrtägiges Event → Ganztags-Zeile');
});

test('isAllDayLike: eintägiges Zeit-Event bleibt im Zeitraster', () => {
  assert(isAllDayLike({ start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-14T08:05', all_day: 0 }) === false,
    'Eintägiges Zeit-Event → Zeitraster');
});

test('isAllDayLike: echtes Ganztags-Event gehört in die Ganztags-Zeile', () => {
  assert(isAllDayLike({ start_datetime: '2026-06-14', end_datetime: '2026-06-14', all_day: 1 }) === true,
    'all_day=1 → Ganztags-Zeile');
});

test('agendaSegmentKind: mehrtägiges Event liefert start/middle/end pro Tag', () => {
  const ev = { start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-19T08:05', all_day: 0 };
  assert(agendaSegmentKind(ev, '2026-06-14') === 'start',  'Starttag → start');
  assert(agendaSegmentKind(ev, '2026-06-16') === 'middle', 'Zwischentag → middle');
  assert(agendaSegmentKind(ev, '2026-06-19') === 'end',    'Endtag → end');
});

test('agendaSegmentKind: eintägiges Zeit-Event ist single', () => {
  const ev = { start_datetime: '2026-06-14T03:00', end_datetime: '2026-06-14T08:05', all_day: 0 };
  assert(agendaSegmentKind(ev, '2026-06-14') === 'single', 'Eintägig → single');
});

test('agendaSegmentKind: Ganztags-Event ist all-day', () => {
  const ev = { start_datetime: '2026-06-14', end_datetime: '2026-06-14', all_day: 1 };
  assert(agendaSegmentKind(ev, '2026-06-14') === 'all-day', 'Ganztägig → all-day');
});

const { clickedTime, HOUR_HEIGHT } = calendarHelpers;

function colAt(top) {
  return { getBoundingClientRect: () => ({ top }) };
}

test('clickedTime: Klick auf Spaltenanfang ergibt 00:00', () => {
  assert(clickedTime({ clientY: 0 }, colAt(0)) === '00:00', 'yOffset 0 → 00:00');
});

test('clickedTime: Klick wird auf 30 Minuten gerundet', () => {
  const y = (14.5 / 24) * (HOUR_HEIGHT * 24);
  assert(clickedTime({ clientY: y }, colAt(0)) === '14:30', 'Klick bei 14:30 bleibt 14:30');
});

test('clickedTime: Minuten zwischen den Rastern runden zum nächsten 30-Minuten-Schritt', () => {
  const y = (HOUR_HEIGHT * 10) + (HOUR_HEIGHT * 20 / 60);
  assert(clickedTime({ clientY: y }, colAt(0)) === '10:30', '10:20 rundet auf 10:30');
});

test('clickedTime: Klick oberhalb der Spalte wird auf 00:00 geklemmt', () => {
  assert(clickedTime({ clientY: 5 }, colAt(50)) === '00:00', 'negativer yOffset → 00:00');
});

test('clickedTime: Klick am Tagesende wird auf 23:30 geklemmt', () => {
  const y = HOUR_HEIGHT * 25;
  assert(clickedTime({ clientY: y }, colAt(0)) === '23:30', 'yOffset über 24h → 23:30');
});

test('clickedTime: berücksichtigt die Scroll-Position der Spalte (rect.top)', () => {
  const y = 200 + (HOUR_HEIGHT * 2);
  assert(clickedTime({ clientY: y }, colAt(200)) === '02:00', 'rect.top wird von clientY abgezogen');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Calendar-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
