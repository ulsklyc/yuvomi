/**
 * Modul: Kalender-Test
 * Zweck: Validiert alle Calendar-API-Abfragen, Datumsbereichs-Filter,
 *        Constraints, CRUD-Logik
 * Ausführen: node --experimental-sqlite test-calendar.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { eachRule } from './css-rules.js';
const { __test: calendarHelpers } = await import('../public/pages/calendar.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

test('Kalender-Speicherbestätigungen halten beide Editor-Save-Gates offen', () => {
  const source = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  for (const [name, nextName] of [
    ['confirmCalendarOverrideOrphans', 'confirmLocalWholeSeriesEdit'],
    ['confirmLocalWholeSeriesEdit', 'confirmLocalWholeSeriesDelete'],
  ]) {
    const start = source.indexOf(`function ${name}(`);
    assert(start >= 0, `${name} muss auffindbar bleiben`);
    const end = source.indexOf(`function ${nextName}(`, start);
    assert(end > start, `${name} muss vor ${nextName} stehen`);
    const body = source.slice(start, end);
    assert(/confirmOverModal\([\s\S]*closeOnConfirm:\s*false/.test(body),
      `${name} darf das Editor-Modal vor dem Save-Lauf nicht schließen`);
  }
});

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

test('Vererbte Serientermin-Erinnerungen verwenden den Server-Anker statt des verschobenen Datums', () => {
  const movedLinkedOccurrence = {
    id: 99,
    start_datetime: '2026-11-02T11:00:00Z',
    reminder_owner_id: 41,
    reminder_anchor_start: '2026-10-01T09:00:00Z',
  };
  const inheritedReminder = { remind_at: '2026-10-01T08:00:00' };

  assert(calendarHelpers.reminderOwnerId(movedLinkedOccurrence) === 41,
    'die Leseroute muss Erinnerungen beim vom Server genannten Owner laden');
  assert(calendarHelpers.reminderOffsetFromEvent(movedLinkedOccurrence, inheritedReminder) === '60',
    'der Offset muss eine Stunde bleiben und darf nicht vom verschobenen 2. November abgeleitet werden');
});

test('Eigene Serientermin-Erinnerungen verwenden den vom Server gelieferten Child-Anker', () => {
  const movedLinkedOccurrence = {
    id: 99,
    start_datetime: '2026-11-02T11:00:00Z',
    reminder_owner_id: 99,
    reminder_anchor_start: '2026-11-02T11:00:00Z',
  };
  const ownedReminder = { remind_at: '2026-11-02T10:45:00' };

  assert(calendarHelpers.reminderOwnerId(movedLinkedOccurrence) === 99);
  assert(calendarHelpers.reminderOffsetFromEvent(movedLinkedOccurrence, ownedReminder) === '15');
});

test('Serientermin-Speichern legt kanonische Reminder-Offsets in den atomaren Body', () => {
  assert(
    JSON.stringify(calendarHelpers.canonicalReminderOffsets([
      { offset: '' },
      { offset: '60' },
      { offset: 'custom', amount: '2', unit: 'days' },
      { offset: '60' },
    ])) === JSON.stringify([60, 2880]),
    'Offsets müssen numerisch, dedupliziert und in Formularreihenfolge an den Occurrence-Endpunkt gehen',
  );
  assert(JSON.stringify(calendarHelpers.canonicalReminderOffsets([], false)) === '[]',
    'ein ausgeschalteter Reminder muss als explizit leeres Offset-Set gesendet werden');
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

test('Deep-Link-Datum: gültiger date-Parameter gewinnt vor Serien-Masterdatum', () => {
  const master = { id: 7, start_datetime: '2026-01-05T09:00' };
  assert(calendarHelpers.deepLinkTargetDate(master, '2026-06-29') === '2026-06-29',
    'date-Parameter muss als Zielinstanz verwendet werden');
});

test('Deep-Link-Datum: ungültiger date-Parameter fällt auf Masterdatum zurück', () => {
  const master = { id: 7, start_datetime: '2026-01-05T09:00' };
  assert(calendarHelpers.validDateParam('not-a-date') === '', 'Ungültige Query wird verworfen');
  assert(calendarHelpers.deepLinkTargetDate(master, 'not-a-date') === '2026-01-05',
    'Ungültige Query darf den Kalenderbereich nicht beschädigen');
});

test('Deep-Link-Instanz: expandiertes Event mit gleichem Datum wird bevorzugt', () => {
  const master = { id: 7, title: 'Training', start_datetime: '2026-01-05T09:00' };
  const occurrence = { id: 7, title: 'Training', start_datetime: '2026-06-29T09:00', is_recurring_instance: 1 };
  const resolved = calendarHelpers.findDeepLinkedOccurrence([master, occurrence], master, '2026-06-29');
  assert(resolved === occurrence, 'Popup/Edit-Flow muss die angeklickte Instanz erhalten');
});

test('Wiederholungsmarke ist nur bei Serien sichtbar und für Screenreader benannt', () => {
  const master = calendarHelpers.calendarRepeatIconHtml({ recurrence_rule: 'FREQ=MONTHLY' });
  const occurrence = calendarHelpers.calendarRepeatIconHtml({ is_recurring_instance: 1 });

  for (const html of [master, occurrence]) {
    assert(html.includes('data-lucide="repeat"'), 'die sichtbare Wiederholungsmarke fehlt');
    assert(html.includes('role="img"'), 'die Markierung braucht eine eigene zugängliche Rolle');
    assert(html.includes('aria-label="calendar.recurringEvent"'), 'die Bedeutung darf nicht nur visuell sein');
  }
  assert(calendarHelpers.calendarRepeatIconHtml({}) === '', 'ein Einzeltermin darf keine Serienmarke bekommen');
  assert(
    calendarHelpers.agendaEventAriaLabel({ title: 'Training', recurrence_rule: 'FREQ=WEEKLY' }, '09:00')
      .startsWith('calendar.recurringEvent, Training, 09:00'),
    'die Agenda überschreibt ihre Kindinhalte mit aria-label und muss die Serienbedeutung dort wiederholen'
  );
  assert(
    calendarHelpers.agendaEventAriaLabel({ title: 'Training' }, '09:00').startsWith('Training, 09:00'),
    'ein Einzeltermin darf im zugänglichen Namen nicht als Serie erscheinen'
  );
  assert(
    calendarHelpers.monthDayAriaLabel('2026-09-30', 2, [
      { title: 'Training', recurrence_rule: 'FREQ=MONTHLY' },
      { title: 'Arzt' },
    ]).includes('calendar.recurringEvent: Training'),
    'die Monatszelle überschreibt ihre Kinder mit aria-label und muss dort den Serientitel nennen'
  );
});

test('Wiederholungsmarke steht vor dem Titel in allen Kalenderansichten mit ausgeschriebenem Titel', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const regions = [
    ['Monat', 'function renderMonthDay', 'function renderWeekView', 1],
    ['Woche', 'function renderWeekView', 'function renderDayView', 2],
    ['Tagesansicht', 'function renderDayView', 'function renderAgendaView', 2],
    ['Agenda', 'function renderAgendaEvent', 'function applyDefaultSyncTarget', 1],
  ];

  for (const [name, from, to, expected] of regions) {
    const body = src.slice(src.indexOf(from), src.indexOf(to));
    const markers = body.match(/calendarRepeatIconHtml\(ev\)/g) ?? [];
    assert(markers.length === expected,
      `${name}: erwartet ${expected} Serienmarken vor ausgeschriebenen Titeln, gefunden ${markers.length}`);
    assert(
      /calendarRepeatIconHtml\(ev\)[\s\S]{0,180}esc\(ev\.title\)/.test(body),
      `${name}: Serienmarke muss vor dem ausgeschriebenen Titel stehen`
    );
  }
});

// --------------------------------------------------------
// nextOccurrence: INTERVAL-Korrektheit mit BYDAY
// --------------------------------------------------------
import { nextOccurrence, nextOccurrenceAfter, seriesStartFor, matchesRRuleByday } from '../server/services/recurrence.js';

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

test('filterTasksForCalendar: done- und abgelegte Tasks werden gefiltert', () => {
  // Abgelegt ist seit #688 kein Status, sondern archived_at - eine abgelegte
  // Aufgabe steht weiter auf 'open' und darf trotzdem keinen Chip bekommen.
  const tasks = [
    { id: 1, title: 'A', due_date: '2026-06-15', status: 'done', archived_at: null },
    { id: 2, title: 'B', due_date: '2026-06-16', status: 'open', archived_at: null },
    { id: 3, title: 'C', due_date: '2026-06-17', status: 'open', archived_at: '2026-06-01T10:00:00Z' },
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

// --------------------------------------------------------
// Ende um Mitternacht (#804)
//
// Ein Zeit-Event, das exakt um Mitternacht endet, belegt den Folgetag nicht.
// Vor dem Fix galt das Ende als inklusiv: das Event landete im Tages-Bucket des
// Folgetags UND wurde als mehrtägig eingestuft, wodurch es über isAllDayLike()
// fälschlich als Ganztags-Balken über beide Tage lief.
//
// Die Ganztags-Fälle sind die Gegenprobe: sie speichern ihr Ende ebenfalls als
// T00:00, meinen es aber INKLUSIV - dort darf die Regel nicht greifen.
// --------------------------------------------------------
const { eventEndDate } = calendarHelpers;

test('eventEndDate: Zeit-Event bis Mitternacht endet am Vortag', () => {
  const ev = { start_datetime: '2026-06-19T21:00', end_datetime: '2026-06-20T00:00', all_day: 0 };
  assert(eventEndDate(ev) === '2026-06-19', 'Fr 21:00–24:00 endet am Freitag');
});

test('eventEndDate: Zeit-Event mit Restminute belegt den Folgetag', () => {
  const ev = { start_datetime: '2026-06-19T21:00', end_datetime: '2026-06-20T00:01', all_day: 0 };
  assert(eventEndDate(ev) === '2026-06-20', 'Ende nach Mitternacht → Folgetag zählt');
});

test('eventEndDate: mehrtägiges Zeit-Event bis Mitternacht verliert nur den Schlusstag', () => {
  const ev = { start_datetime: '2026-06-14T09:00', end_datetime: '2026-06-19T00:00', all_day: 0 };
  assert(eventEndDate(ev) === '2026-06-18', 'Endet am 18., nicht am 19.');
});

test('eventEndDate: Ganztags-Event behält seinen Schlusstag', () => {
  // Regressionsschutz: Ganztags-Events speichern das Ende als T00:00 und meinen
  // es inklusiv - eine Reise 07.–09.09. darf am 09. nicht verschwinden.
  const ev = { start_datetime: '2026-09-07T00:00', end_datetime: '2026-09-09T00:00', all_day: 1 };
  assert(eventEndDate(ev) === '2026-09-09', 'Ganztags-Ende bleibt inklusiv');
});

test('eventEndDate: datums-only Ende bleibt unangetastet', () => {
  const ev = { start_datetime: '2026-06-14', end_datetime: '2026-06-16', all_day: 1 };
  assert(eventEndDate(ev) === '2026-06-16', 'Ohne Zeitanteil greift die Regel nicht');
});

test('eventEndDate: ohne Enddatum gilt der Starttag', () => {
  const ev = { start_datetime: '2026-06-14T09:00', end_datetime: null, all_day: 0 };
  assert(eventEndDate(ev) === '2026-06-14', 'Kein Ende → Starttag');
});

// --------------------------------------------------------
// eventWhenText (#1102): die „Wann"-Zeile der Detailansicht nennt den Endtag,
// sobald er ein anderer ist - nach derselben Regel wie das Raster.
//
// Der i18n-Stub gibt Datum und Uhrzeit unverändert zurück (formatTime also den
// ganzen Zeitstempel) und hängt die Werte als JSON an den Key. Ein Ende OHNE
// Datum ist deshalb der blanke Zeitstempel, ein Ende MIT Datum trägt das
// Datum davor: "2026-09-12 2026-09-12T11:00".
// --------------------------------------------------------
const { eventWhenText } = calendarHelpers;
const whenRange = (text) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

test('eventWhenText: eintägiges Zeit-Event nennt vom Ende nur die Uhrzeit', () => {
  const text = eventWhenText({ start_datetime: '2026-09-10T14:00', end_datetime: '2026-09-10T15:30', all_day: 0 });
  assert(text.startsWith('calendar.dayRangeLabel'), `Zeitraum über den Locale-Key: ${text}`);
  assert(whenRange(text).to === '2026-09-10T15:30', `Ende ohne vorangestelltes Datum: ${text}`);
});

test('eventWhenText: mehrtägiges Zeit-Event nennt Enddatum und Enduhrzeit', () => {
  const text = eventWhenText({ start_datetime: '2026-09-10T14:00', end_datetime: '2026-09-12T11:00', all_day: 0 });
  assert(whenRange(text).from === '2026-09-10 2026-09-10T14:00', `Start mit Datum: ${text}`);
  assert(whenRange(text).to === '2026-09-12 2026-09-12T11:00', `Enddatum steht vor der Uhrzeit: ${text}`);
});

test('eventWhenText: Zeit-Event bis 00:00 des Folgetags bleibt eintägig', () => {
  const text = eventWhenText({ start_datetime: '2026-09-10T21:00', end_datetime: '2026-09-11T00:00', all_day: 0 });
  assert(whenRange(text).to === '2026-09-11T00:00', `21:00-24:00 gehört dem Abend (#804): ${text}`);
});

test('eventWhenText: mehrtägiges Zeit-Event bis 00:00 nennt den echten Endzeitpunkt, nicht den letzten Rastertag', () => {
  // Review auf #1114, entschieden: das Raster fuehrt den Termin am 1. und 2.,
  // die Zeile nennt aber, WANN er endet - am 3. um 00:00. Das Datum aus
  // eventEndDate() mit der rohen Uhrzeit hiesse "2. 00:00", einen Tag zu frueh.
  const ev = { start_datetime: '2026-01-01T14:00', end_datetime: '2026-01-03T00:00', all_day: 0 };
  assert(eventEndDate(ev) === '2026-01-02', 'das Raster endet am 2. (#804)');
  const text = eventWhenText(ev);
  assert(whenRange(text).to === '2026-01-03 2026-01-03T00:00', `Ende ist der 3. um 00:00: ${text}`);
});

test('eventWhenText: mehrtägiges Ganztags-Event nennt beide Tage', () => {
  const text = eventWhenText({ start_datetime: '2026-09-10T00:00', end_datetime: '2026-09-12T00:00', all_day: 1 });
  assert(text === 'calendar.dayRangeLabel{"from":"2026-09-10","to":"2026-09-12"} · calendar.allDay',
    `Ende inklusiv, beide Tage genannt: ${text}`);
});

test('eventWhenText: eintägiges Ganztags-Event und Termin ohne Ende bleiben unverändert', () => {
  const allDay = eventWhenText({ start_datetime: '2026-09-10T00:00', end_datetime: '2026-09-10T00:00', all_day: 1 });
  assert(allDay === '2026-09-10 · calendar.allDay', `Ein Tag, kein Zeitraum: ${allDay}`);
  const open = eventWhenText({ start_datetime: '2026-09-10T14:00', end_datetime: null, all_day: 0 });
  assert(open === '2026-09-10 2026-09-10T14:00', `Ohne Ende nur der Start: ${open}`);
});

test('eventEndDate: Ende vor dem Start fällt auf den Starttag zurück', () => {
  const ev = { start_datetime: '2026-06-14T09:00', end_datetime: '2026-06-13T00:00', all_day: 0 };
  assert(eventEndDate(ev) === '2026-06-14', 'Verdrehtes Ende erzeugt keinen Rückwärtsbereich');
});

test('isMultiDayEvent: Zeit-Event bis Mitternacht ist nicht mehrtägig (#804)', () => {
  const ev = { start_datetime: '2026-06-19T21:00', end_datetime: '2026-06-20T00:00', all_day: 0 };
  assert(isMultiDayEvent(ev) === false, 'Fr 21:00–24:00 ist ein Eintagestermin');
});

test('isAllDayLike: Zeit-Event bis Mitternacht bleibt im Zeitraster (#804)', () => {
  const ev = { start_datetime: '2026-06-19T21:00', end_datetime: '2026-06-20T00:00', all_day: 0 };
  assert(isAllDayLike(ev) === false, 'Darf nicht in die Ganztags-Zeile rutschen');
});

test('agendaSegmentKind: Zeit-Event bis Mitternacht ist single (#804)', () => {
  const ev = { start_datetime: '2026-06-19T21:00', end_datetime: '2026-06-20T00:00', all_day: 0 };
  assert(agendaSegmentKind(ev, '2026-06-19') === 'single', 'Ein Segment am Freitag');
});

const { clickedTime } = calendarHelpers;

/* Die Stundenhöhe kommt nicht mehr aus einer Konstante in calendar.js, sondern
 * wird an der Spalte gemessen (sie ist immer 24 Stunden hoch) - deshalb trägt
 * die Attrappe hier jetzt eine Höhe. Das ist genau die Zusage, die der Test
 * hält: Woche (56px) und die dichtere Tagesansicht (40px) müssen für denselben
 * Klick-Anteil dieselbe Uhrzeit ergeben. Vorher war die Zahl 56 in Test und
 * Quelle verdrahtet und ein zweites Raster wäre unbemerkt falsch gelandet. */
const WEEK_HOUR = 56;
const DAY_HOUR  = 40;

function colAt(top, hourHeight = WEEK_HOUR) {
  return { getBoundingClientRect: () => ({ top, height: hourHeight * 24 }) };
}

test('clickedTime: Klick auf Spaltenanfang ergibt 00:00', () => {
  assert(clickedTime({ clientY: 0 }, colAt(0)) === '00:00', 'yOffset 0 → 00:00');
});

test('clickedTime: Klick wird auf 30 Minuten gerundet', () => {
  const y = (14.5 / 24) * (WEEK_HOUR * 24);
  assert(clickedTime({ clientY: y }, colAt(0)) === '14:30', 'Klick bei 14:30 bleibt 14:30');
});

test('clickedTime: Minuten zwischen den Rastern runden zum nächsten 30-Minuten-Schritt', () => {
  const y = (WEEK_HOUR * 10) + (WEEK_HOUR * 20 / 60);
  assert(clickedTime({ clientY: y }, colAt(0)) === '10:30', '10:20 rundet auf 10:30');
});

test('clickedTime: Klick oberhalb der Spalte wird auf 00:00 geklemmt', () => {
  assert(clickedTime({ clientY: 5 }, colAt(50)) === '00:00', 'negativer yOffset → 00:00');
});

test('clickedTime: Klick am Tagesende wird auf 23:30 geklemmt', () => {
  const y = WEEK_HOUR * 25;
  assert(clickedTime({ clientY: y }, colAt(0)) === '23:30', 'yOffset über 24h → 23:30');
});

test('clickedTime: berücksichtigt die Scroll-Position der Spalte (rect.top)', () => {
  const y = 200 + (WEEK_HOUR * 2);
  assert(clickedTime({ clientY: y }, colAt(200)) === '02:00', 'rect.top wird von clientY abgezogen');
});

test('clickedTime: liest die Stundenhöhe der Spalte, nicht eine feste Zahl', () => {
  const y = DAY_HOUR * 14.5;
  assert(clickedTime({ clientY: y }, colAt(0, DAY_HOUR)) === '14:30',
    'dichteres Tagesraster (40px/Stunde) trifft dieselbe Uhrzeit');
  assert(clickedTime({ clientY: WEEK_HOUR * 14.5 }, colAt(0, WEEK_HOUR)) === '14:30',
    'und die Wochenansicht (56px/Stunde) ebenso');
});

test('clickedTime: eine Spalte ohne messbare Höhe legt nichts Falsches an', () => {
  const noHeight = { getBoundingClientRect: () => ({ top: 0, height: 0 }) };
  assert(clickedTime({ clientY: 400 }, noHeight) === '09:00',
    'ohne Layout fällt der Klick auf eine ruhige Vormittagszeit zurück statt auf 00:00');
});

// --------------------------------------------------------
// Tagesraster: die Ebenenregel der Now-Linie
// --------------------------------------------------------

/* DIE ZUSAGE: im Tagesraster liegt die Now-LINIE unter den Terminen und der
 * PUNKT über allem. Genau daran scheiterte die Vorlage (Screenshot 05): die
 * Linie lag mit z-index 2 über dem 09:00-Termin und machte dessen Text
 * unlesbar. Die Regel ist eine reine Stapelaussage und bricht deshalb lautlos -
 * ein einzelnes hochgezogenes z-index irgendwo in calendar.css genügt, und
 * niemand sieht es, bis jemand mittags in seinen Kalender schaut.
 *
 * Geprüft wird über eachRule() (der EINE Regelscanner), nicht über ein eigenes
 * Regex: das alte Muster war dreimal blind und jedes Mal war der Guard grün. */
const calendarCss = readFileSync(new URL('../public/styles/calendar.css', import.meta.url), 'utf8');

test('Wochenraster: Kopf, Ganztagszeile und Stunden verwenden dieselbe Zeitspaltenbreite', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const renderWeekView = src.slice(
    src.indexOf('function renderWeekView'),
    src.indexOf('function renderDayView'),
  );
  const gutterColumns = renderWeekView.match(
    /grid-template-columns:var\(--cal-gutter-width\) repeat\(\$\{colCount\},1fr\)/g,
  ) ?? [];
  const timeGutter = [...eachRule(calendarCss)]
    .find((rule) => rule.selector.trim() === '.week-view__times');

  assert(gutterColumns.length === 2,
    'Kopf und Ganztagszeile müssen --cal-gutter-width verwenden; die Stundenleiste darunter '
    + 'verwendet dasselbe Token und sonst laufen die Tagesgrenzen auseinander');
  assert(timeGutter && /width:\s*var\(--cal-gutter-width\)/.test(timeGutter.body),
    'die Stundenleiste muss ihre Breite aus --cal-gutter-width beziehen');
  assert(!renderWeekView.includes('grid-template-columns:var(--space-12)'),
    'die Wochenansicht darf nicht auf die alte 48px-Sprosse zurückfallen');
});

/* EINE SPUR IN DER RICHTIGEN BREITE IST NOCH KEINE FLUCHTLINIE.
 *
 * Die Prüfung darüber sichert die SPALTE. Was in ihr steht, hat sie nicht
 * gesehen: die Ganztags-Beschriftung stand auf --space-12 (48px) in der
 * 64px-Spur, ist rechtsbündig und endete deshalb 16px links von den
 * Stundenzahlen, die genau darunter anfangen - der Versatz überlebte den Fix
 * für die Spalten. Beide Texte enden nur dann auf derselben Kante, wenn sie
 * dieselbe Breite UND dasselbe padding-right haben. */
test('Ganztags-Beschriftung endet auf derselben Kante wie die Stundenzahlen', () => {
  const rules = [...eachRule(calendarCss)];
  const label = rules.find((rule) => rule.selector.trim() === '.calendar-all-day-label');
  const slot = rules.find((rule) => rule.selector.trim() === '.week-view__time-slot');

  assert(label && slot, 'Beschriftung und Stundenschlitz müssen beide eine eigene Regel haben');
  assert(/width:\s*var\(--cal-gutter-width\)/.test(label.body),
    'die Ganztags-Beschriftung muss die volle Zeitspalte füllen, nicht --space-12');

  const paddingRight = (body) => body.match(/padding(?:-right)?:\s*([^;]+)/)?.[1]?.trim() ?? '';
  const labelPad = paddingRight(label.body).split(/\s+/)[1] ?? paddingRight(label.body);
  assert(labelPad === paddingRight(slot.body),
    `rechter Innenabstand läuft auseinander: Beschriftung ${labelPad}, Stunde ${paddingRight(slot.body)}`);
});

function zIndexOf(selector) {
  for (const rule of eachRule(calendarCss)) {
    if (!rule.selector.split(',').map((s) => s.trim()).includes(selector)) continue;
    const match = rule.body.match(/(?:^|;)\s*z-index\s*:\s*(-?\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

test('Tagesraster: die Now-Linie liegt UNTER den Terminen, der Punkt darüber', () => {
  const line  = zIndexOf('.day-view__now-line');
  const dot   = zIndexOf('.day-view__now-dot');
  const event = zIndexOf('.day-event');
  assert(line !== null,  '.day-view__now-line hat kein z-index - die Ebenenregel steht nirgends');
  assert(dot !== null,   '.day-view__now-dot hat kein z-index');
  assert(event !== null, '.day-event hat kein z-index');
  assert(line < event, `Now-Linie (${line}) muss unter dem Termin (${event}) liegen, sonst streicht sie seinen Titel durch`);
  assert(dot > event,  `Now-Punkt (${dot}) muss über dem Termin (${event}) liegen, sonst ist „jetzt" verdeckt`);
});

test('Tagesraster: der Now-Punkt sitzt in der Stundenspalte, wo nie ein Termin steht', () => {
  const rule = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.day-view__now-dot');
  assert(rule, '.day-view__now-dot fehlt');
  assert(/inset-inline-start|left/.test(rule.body) && /--cal-gutter-width/.test(rule.body),
    'der Punkt muss seine Position aus --cal-gutter-width beziehen - sonst wandert er beim nächsten '
    + 'Spaltenmass in die Terminspalte, und die halbe Ebenenregel ist wieder hin');
});

test('Tagesraster: die Dichte kommt aus EINEM Token, nicht aus einer zweiten Zahl', () => {
  const dayView = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.day-view');
  assert(dayView, '.day-view fehlt');
  assert(/--cal-hour-height:\s*var\(--cal-hour-height-day\)/.test(dayView.body),
    '.day-view muss --cal-hour-height auf die Tages-Sprosse umbiegen; sonst rechnet hourOffset() '
    + 'gegen die Wochenhöhe und Termine, Stundenlinien und Now-Linie laufen auseinander');
  // OHNE KOMMENTARE. Der Guard fand beim ersten Lauf seinen eigenen Anlass:
  // der Kommentar über hourOffset() ZITIERT `HOUR_HEIGHT = 56`, um zu erklären,
  // warum es die Konstante nicht mehr gibt. Ein Guard, der Prosa liest, meldet
  // die Beschreibung eines Fehlers als den Fehler - dieselbe Falle, wegen der
  // eachRule() die Kommentare strippt.
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/\bHOUR_HEIGHT\s*=\s*\d/.test(src),
    'calendar.js darf die Stundenhöhe nicht als Zahl führen - sie steht in tokens.css');
});

/* ---------------------------------------------------------------------------
 * Vorbelegtes Datum eines neuen Termins ohne angeklickten Tag (#737)
 *
 * Anlassfall: In der Tagesansicht drei Tage vorblättern, „+" drücken - der
 * Termin lag auf heute, nicht auf dem Tag auf dem Schirm. Dieselbe Überraschung
 * gab es in Woche, Monat und Agenda, nur weiter entfernt.
 *
 * Regel: Heute gewinnt, solange die Ansicht heute zeigt; sonst der erste Tag des
 * sichtbaren Zeitraums. Die Fälle „heute sichtbar" stehen mit im Test, sonst
 * bewiese er nur die halbe Regel und ein `return from` käme grün durch.
 * ------------------------------------------------------------------------- */
const newEventDate = calendarHelpers.newEventDefaultDate;
const TODAY = '2026-08-14';                                   // Freitag

test('Tagesansicht: das „+" nimmt den angezeigten Tag, nicht heute', () => {
  assert(newEventDate('day', '2026-09-20', TODAY) === '2026-09-20',
    'ein vorgeblätterter Tag muss der Vorschlag sein');
  assert(newEventDate('day', TODAY, TODAY) === TODAY,
    'auf heute stehend bleibt es heute');
});

test('Monatsansicht: der erste des angezeigten Monats, aber heute wenn heute drin liegt', () => {
  assert(newEventDate('month', '2026-09-20', TODAY) === '2026-09-01',
    'im September muss der 1. September herauskommen');
  assert(newEventDate('month', '2026-08-30', TODAY) === TODAY,
    'im laufenden Monat bleibt heute der Vorschlag - der Nutzer sieht ihn ja');
  assert(newEventDate('month', '2026-02-20', TODAY) === '2026-02-01',
    'auch rückwärts der Monatserste, nicht das Rasterende');
});

test('Monatsansicht: der Vorschlag ist der Monatserste, nicht der Rasteranfang', () => {
  // getRangeForView() liefert für den Monat das 42-Tage-Raster und beginnt im
  // Vormonat. Wer diesen Vorschlag daraus ableitet, legt Termine aus der
  // September-Ansicht heraus im August an. September 2026 beginnt an einem
  // Dienstag, das Raster also am 31.08.
  assert(newEventDate('month', '2026-09-20', TODAY) !== '2026-08-31',
    'der Rasteranfang des Vormonats darf nie der Vorschlag sein');
});

test('Wochenansicht: der Wochenstart des angezeigten Zeitraums, im gewählten Wochenstart', () => {
  assert(newEventDate('week', '2026-09-16', TODAY, 1) === '2026-09-14',
    'Wochenstart Montag: Mittwoch 16.09. gehört zur Woche ab Montag 14.09.');
  assert(newEventDate('week', '2026-09-16', TODAY, 0) === '2026-09-13',
    'Wochenstart Sonntag: dieselbe Woche beginnt am 13.09.');
  assert(newEventDate('week', '2026-08-12', TODAY, 1) === TODAY,
    'liegt heute in der angezeigten Woche, gewinnt heute');
});

test('Agenda: der Listenanfang, sobald heute außerhalb der 30 Tage liegt', () => {
  assert(newEventDate('agenda', '2026-10-01', TODAY) === '2026-10-01',
    'vorgeblätterte Agenda schlägt ihren eigenen Anfang vor');
  assert(newEventDate('agenda', '2026-08-01', TODAY) === TODAY,
    'heute liegt im 30-Tage-Fenster ab 01.08. und gewinnt');
});

test('ohne Cursor bleibt es bei heute', () => {
  assert(newEventDate('month', null, TODAY) === TODAY, 'null-Cursor fällt auf heute zurück');
  assert(newEventDate('day', '', TODAY) === TODAY, 'leerer Cursor fällt auf heute zurück');
});

test('jedes „+" ohne angeklickten Tag reicht ein Datum durch (nur die Suche nicht)', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Regel über ALLE create-Aufrufe, nicht über eine Liste bekannter Zeilen: sonst
  // deckt der Guard N Fundstellen ab statt der Regel, und ein neuer Knopf fiele
  // still durch.
  const creates = src.match(/openEventModal\(\{\s*mode:\s*'create'[^)]*\)/g) || [];
  assert(creates.length >= 5, `zu wenige create-Aufrufe gefunden (${creates.length}) - Regex greift nicht mehr`);
  const withoutDate = creates.filter((call) => !/\bdate:/.test(call));
  assert(withoutDate.length === 1,
    `genau ein „+" darf ohne Datum öffnen (der Leerzustand der Suche, dort steht kein Zeitraum `
    + `auf dem Schirm), gefunden: ${withoutDate.length} - ${withoutDate.join(' | ')}`);
});

// --------------------------------------------------------
// Wochenend-Tönung im Monatsraster (#780)
// --------------------------------------------------------

/**
 * Baut dieselben 42 Rasterzellen wie renderMonthView für einen gegebenen
 * Wochenstart und liefert je Zelle {date, weekday, tinted, column}.
 * `tinted` kommt aus dem echten Klassen-Bauer der Seite, nicht aus einer
 * Testkopie seiner Regel.
 */
function monthGrid(year, month, weekStart) {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset  = (firstOfMonth.getDay() - weekStart + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const dt = new Date(year, month, 1 - startOffset + i);
    const y  = dt.getFullYear();
    const m  = String(dt.getMonth() + 1).padStart(2, '0');
    const d  = String(dt.getDate()).padStart(2, '0');
    const date = `${y}-${m}-${d}`;
    return {
      date,
      weekday: dt.getDay(),
      column:  (i % 7) + 1,          // 1..7, wie :nth-child im 7-Spalten-Raster
      tinted:  calendarHelpers.monthDayClasses(date, dt.getMonth() === month, '')
        .split(' ').includes('month-day--weekend'),
    };
  });
}

// Der Anlassfall des Bugreports: Wochenstart Sonntag. Geprüft wird für ALLE drei
// Wochenstarts, dass genau Sa/So getönt sind - und mit der Gegenprobe, dass die
// frühere Spaltenregel (:nth-child(7n) / 7n-1 = letzte zwei Spalten) bei nicht-
// montäglichem Start eben NICHT dasselbe ergibt. Ohne die Gegenprobe wäre der
// Guard auch über dem alten, kaputten Stand grün gewesen.
for (const [label, weekStart] of [['Montag', 1], ['Sonntag', 0], ['Samstag', 6]]) {
  test(`Monatsraster: bei Wochenstart ${label} sind genau Sa/So getönt`, () => {
    for (const { year, month } of [{ year: 2026, month: 7 }, { year: 2026, month: 1 }, { year: 2027, month: 0 }]) {
      for (const cell of monthGrid(year, month, weekStart)) {
        const isWeekend = cell.weekday === 0 || cell.weekday === 6;
        assert(cell.tinted === isWeekend,
          `${cell.date} (getDay ${cell.weekday}, Spalte ${cell.column}, Wochenstart ${label}): `
          + `getönt=${cell.tinted}, erwartet=${isWeekend}`);
      }
    }
  });
}

test('Monatsraster: die Tönung folgt dem Wochentag, nicht der Spaltenposition', () => {
  // Gegenprobe gegen den alten Stand: die letzten beiden Spalten (7n-1, 7n).
  const positional = (cell) => cell.column === 6 || cell.column === 7;
  const sunday = monthGrid(2026, 7, 0);
  assert(sunday.some((cell) => cell.tinted !== positional(cell)),
    'bei Sonntag-Start müssen sich Wochentags- und Spaltenregel unterscheiden - '
    + 'sonst prüft dieser Guard nichts');
  const monday = monthGrid(2026, 7, 1);
  assert(monday.every((cell) => cell.tinted === positional(cell)),
    'bei Montag-Start dürfen beide Regeln dasselbe ergeben (Regression der Standardansicht)');
});

test('Monatsraster: das CSS hängt die Tönung an die Klasse, nicht an nth-child', () => {
  // Der Filter fragt die ZUSICHERUNG ab (eine Wochenend-Zelle wird ueber ihre
  // Klasse gemalt), nicht die Farbquelle: bis 2026-08-27 suchte er
  // `--module-accent` im Regelkoerper und haette den Wechsel der Toenung auf
  // den neutralen Well (Herkunfts-Regel: „Wochenende" ist keine
  // Herkunftsaussage) als „verschwunden" gemeldet, obwohl die Regel steht.
  const tint = [...eachRule(calendarCss)]
    .filter((r) => /background-color/.test(r.body))
    .filter((r) => r.selector.includes('.month-day--weekend'));
  assert(tint.length > 0, 'die Wochenend-Tönung im Monatsraster ist verschwunden');
  for (const rule of tint) {
    assert(!/nth-child/.test(rule.selector),
      `die Tönung darf nicht an der Spaltenposition hängen (${rule.selector}): die Spalte sagt nur `
      + 'bei Wochenstart Montag den Wochentag');
  }
  // Die Gegenrichtung, seit dem Quellen-Wechsel ausdruecklich: KEINE Regel
  // malt eine Monatszelle ueber ihre Spaltenposition (#780).
  const positional = [...eachRule(calendarCss)]
    .filter((r) => r.selector.includes('.month-day') && /nth-child/.test(r.selector)
      && /background-color/.test(r.body));
  assert(positional.length === 0,
    `eine Monatszelle wird ueber nth-child gemalt: ${positional.map((r) => r.selector).join(', ')}`);
});

// --------------------------------------------------------
// Geburtstags-Ebene (#778)
//
// Geburtstage kommen aus den Kontakten und fuellen bei einem grossen Adressbuch
// den Kalender mit Terminen, die niemand als Termin geplant hat. Sie einzeln zu
// loeschen half nicht - der naechste Abgleich legt sie wieder an ("keeps coming
// back"). Sie sind deshalb eine Ebene wie die Feiertage.
// --------------------------------------------------------

test('Die Geburtstags-Ebene blendet genau die Geburtstage aus', () => {
  const geburtstag = { id: 1, title: 'Anna', birthday_name: 'Anna' };
  const termin     = { id: 2, title: 'Zahnarzt' };

  assert(calendarHelpers.isVisibleLayer(geburtstag, false) === false, 'ausgeschaltet verschwindet der Geburtstag');
  assert(calendarHelpers.isVisibleLayer(geburtstag, true)  === true,  'eingeschaltet ist er da');
  assert(calendarHelpers.isVisibleLayer(termin, false) === true,
    'ein gewoehnlicher Termin darf von der Ebene nie betroffen sein - sonst raeumt der Schalter den Kalender leer');
  assert(calendarHelpers.isVisibleLayer(termin, true) === true);
});

test('Der Marker ist birthday_name, nicht der Titel', () => {
  // Ein Termin, der zufaellig "Geburtstag" heisst, gehoert dem Nutzer und bleibt.
  const eigener = { id: 3, title: 'Geburtstagsfeier planen' };
  assert(calendarHelpers.isVisibleLayer(eigener, false) === true);
});

// --------------------------------------------------------
// Farbhierarchie (#815)
// --------------------------------------------------------

test('die eigene Terminfarbe schlaegt die Farbe der zugewiesenen Person', () => {
  // Der belegte Fall aus #815: ein CalDAV-Termin bringt seine RFC-7986-`COLOR`
  // mit, wird jemandem zugewiesen - und war bis v2.35.0 unsichtbar, weil die
  // Personenfarbe alles schlug. Die Sync war nie das Problem.
  const { resolveEventColor } = calendarHelpers;
  const assignee = [{ id: 1, color: '#FF0000' }];

  assert(resolveEventColor({ color: '#00FF00', assigned_users: assignee, cal_color: '#0000FF' }) === '#00FF00',
    'die ausdrueckliche Terminfarbe muss die Zuweisung schlagen');
  // Gegenprobe: OHNE eigene Farbe gewinnt die Person weiter - gegen die
  // Kalenderfarbe, die jeder Termin des Kalenders traegt und die deshalb nichts
  // ueber diesen einen aussagt. Ohne diese Haelfte waere der Test auch dann
  // gruen, wenn die Zuweisung gar nicht mehr faerbte.
  //
  // DIESE HAELFTE WAR BIS v2.48.0 BLIND, und das ist der Grund, warum sie hier
  // so ausfuehrlich steht. `calendar_events.color` war NOT NULL und lehnte auch
  // den Leerstring ab - ein Termin AUS DER DATENBANK konnte die beiden unteren
  // Zweige nie erreichen, der Test war also gruen ueber totem Code und sagte
  // nichts darueber, was ein Nutzer zu sehen bekommt (#856).
  //
  // Seit Migration 166 darf die Spalte NULL sein, und erst damit traegt diese
  // Haelfte eine Zusicherung. Dass ein NULL auch wirklich aus der Route und aus
  // dem Sync herauskommt, kann dieser Frontend-Test aber nicht zeigen - das
  // pruefen `test:calendar-routes` (Route) und `test:calendar-inherited-color`
  // (Migration + Importpfade). Ohne die beiden waere er wieder blind.
  assert(resolveEventColor({ assigned_users: assignee, cal_color: '#0000FF' }) === '#FF0000',
    'ohne eigene Farbe muss die Zuweisung faerben');
  assert(resolveEventColor({ cal_color: '#0000FF' }) === '#0000FF',
    'ohne Zuweisung bleibt die Kalenderfarbe');
  assert(resolveEventColor({}) === '#8E8E93',
    'ohne alles bleibt das neutrale Grau');
});

test('die geerbte Farbe gehoert der PRIMAEREN Zuweisung, nicht der ersten Zeile', () => {
  // `assigned_users` kommt aus einem `json_group_array` OHNE `ORDER BY`: seine
  // Reihenfolge ist die der `event_assignments`-Zeilen, nicht die des Formulars.
  // Die primaere Zuweisung steht ausdruecklich in `assigned_to`. Ohne die
  // Unterscheidung traegt ein Termin mit mehreren Zugewiesenen die Farbe eines
  // ANDEREN Mitglieds - und kann sie beim Neuladen wechseln, ohne dass jemand
  // etwas geaendert hat. Solange die Spalte NOT NULL war, war der Zweig tot und
  // der Fehler unsichtbar (#891).
  const { resolveEventColor } = calendarHelpers;
  const ev = {
    color: null,
    assigned_to: 7,
    assigned_users: [{ id: 3, color: '#3CA368' }, { id: 7, color: '#CE5053' }],
  };
  assert(resolveEventColor(ev) === '#CE5053',
    'die Farbe muss der in assigned_to genannten Person gehoeren');

  // Gegenprobe: die naive Fassung greift daneben - ohne diese Zeile waere der
  // Test auch dann gruen, wenn beide Personen dieselbe Farbe traegen.
  assert(ev.assigned_users[0].color === '#3CA368',
    'die erste Zeile traegt eine ANDERE Farbe - sonst prueft der Test nichts');

  // Faellt assigned_to aus (Altbestand, geloeschtes Mitglied), bleibt die erste
  // Zeile die beste verfuegbare Auskunft.
  assert(resolveEventColor({ color: null, assigned_to: null, assigned_users: [{ id: 3, color: '#3CA368' }] }) === '#3CA368',
    'ohne assigned_to gilt die erste Zeile');
  assert(resolveEventColor({ color: null, assigned_to: 99, assigned_users: [{ id: 3, color: '#3CA368' }] }) === '#3CA368',
    'zeigt assigned_to auf niemanden in der Liste, ebenso');
});

test('eine Zuweisung ohne eigene Farbe faellt nicht auf die Kalenderfarbe durch', () => {
  // Ein Mitglied ohne gesetzte Avatar-Farbe bekommt das neutrale Grau, nicht die
  // Kalenderfarbe: sonst saehe ein zugewiesener Termin aus wie ein nicht
  // zugewiesener, und die Zuweisung waere unsichtbar statt nur farblos.
  assert(calendarHelpers.resolveEventColor({ assigned_users: [{ id: 1 }], cal_color: '#0000FF' }) === '#8E8E93',
    'ein Mitglied ohne Farbe darf nicht auf die Kalenderfarbe durchfallen');
});

// --------------------------------------------------------
// Der Farbwaehler zeigt, was gilt (#856)
// --------------------------------------------------------

test('der Farbwaehler zeigt eine Farbe, die nicht aus seiner Palette stammt', () => {
  // #856: Die Avatar-Palette (iOS-Systemfarben) und EVENT_COLORS (OKLCH) teilen
  // KEINEN einzigen Wert - das ist der Kern des Bugs, also wird es hier zuerst
  // festgehalten. Traegt ein Termin eine Avatar-Farbe, eine RFC-7986-Farbe vom
  // CalDAV-Server oder das alte '#007AFF', stand der Waehler leer da; der
  // Speicherpfad schrieb daraufhin die erste Palettenfarbe darueber.
  const { pickerColors, EVENT_COLORS } = calendarHelpers;
  const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
  const shared = AVATAR_COLORS.filter((a) => EVENT_COLORS.some((e) => e.toLowerCase() === a.toLowerCase()));
  assert(shared.length === 0,
    'die beiden Paletten duerfen sich nicht ueberschneiden - sonst prueft dieser Test nichts');

  const own = pickerColors({ color: '#34C759' });
  assert(own.length === EVENT_COLORS.length + 1, 'die fremde Farbe kommt als zusaetzlicher Swatch dazu');
  assert(own[0] === '#34C759', 'und steht vorn, damit sie den aktiven Swatch bekommt');

  assert(pickerColors({ color: EVENT_COLORS[3] }).length === EVENT_COLORS.length,
    'eine Farbe AUS der Palette bekommt keinen zweiten Swatch');
  assert(pickerColors({ color: EVENT_COLORS[3].toLowerCase() }).length === EVENT_COLORS.length,
    'auch dann nicht, wenn der Server sie klein schreibt - CalDAV tut das');
  assert(pickerColors(null).length === EVENT_COLORS.length,
    'ein neuer Termin zeigt genau die Palette');
  assert(pickerColors({ color: null }).length === EVENT_COLORS.length,
    'ohne Farbe ebenso');
});

test('der Farbwaehler nimmt nur an, was wie eine Farbe aussieht', () => {
  // Der Wert landet in einem style-Attribut. esc() verhindert das Ausbrechen,
  // nicht aber eine zweite CSS-Deklaration dahinter - und die Sync-Dienste
  // schreiben direkt in die Tabelle, an COLOR_RE aus validate.js vorbei.
  const { pickerColors, EVENT_COLORS } = calendarHelpers;
  for (const bad of ['red; background-image:url(x)', 'rgb(1,2,3)', '#FFF', '#12345', '#GGGGGG', '', 'javascript:x']) {
    assert(pickerColors({ color: bad }).length === EVENT_COLORS.length,
      `'${bad}' darf keinen Swatch bekommen`);
  }
  assert(pickerColors({ color: '#abc123' })[0] === '#abc123',
    'ein gueltiger Hex in Kleinschreibung dagegen schon');
});

test('ein Speichern, das die Farbe nicht anfasst, veraendert sie nicht', () => {
  // Die Invariante, um die es in #856 geht. Sie steht hier bewusst NEBEN der
  // alten Formel: die zeigt, dass der Test etwas misst, und nicht bloss die
  // Implementierung nachspricht, die gerade danebensteht.
  const { colorToSave, EVENT_COLORS } = calendarHelpers;
  const alteFormel = (aktiv) => aktiv || EVENT_COLORS[0];

  // Ein Termin mit der Avatar-Farbe einer Person. Kein Swatch der Palette passt,
  // also ist beim Oeffnen keiner aktiv - und der Nutzer fasst die Farbe nicht an.
  const termin = { color: '#34C759' };
  assert(colorToSave(undefined, termin) === '#34C759',
    'die Farbe des Termins bleibt stehen');
  assert(alteFormel(undefined) === EVENT_COLORS[0],
    'die alte Formel schrieb hier die erste Palettenfarbe darueber - das war der Bug');

  // Wer eine Farbe waehlt, bekommt sie auch.
  assert(colorToSave('#8156C0', termin) === '#8156C0',
    'ein aktiver Swatch schlaegt die bisherige Farbe');
});

test('ein neuer Termin faengt OHNE eigene Farbe an, damit die Zuweisung faerben kann', () => {
  // Die Verhaltensaenderung aus #891, und die zweite Haelfte desselben Bugs wie
  // oben: #856 hat verhindert, dass BEARBEITEN eine Farbe umschreibt. Beim
  // ANLEGEN schrieb dieselbe Formel den Palettenersten weiterhin fest, und weil
  // er von einer bewussten Wahl nicht zu unterscheiden war, hat er die Farbe der
  // zugewiesenen Person auf Dauer verdraengt - fuer JEDEN neuen Termin.
  const { colorToSave, EVENT_COLORS } = calendarHelpers;
  const alteFormel = (aktiv, ev) => aktiv || ev?.color || EVENT_COLORS[0];

  assert(colorToSave(undefined, null) === null,
    'ohne Termin und ohne Auswahl wird KEINE Farbe geschrieben');
  assert(alteFormel(undefined, null) === EVENT_COLORS[0],
    'die alte Formel legte hier den Palettenersten fest - genau der verdraengte die Person');
  assert(colorToSave(undefined, { color: null }) === null,
    'ein Termin ohne Farbe behaelt keine');
});

test('der Erben-Swatch ist eine ausdrueckliche Wahl, kein fehlender Wert', () => {
  // Der Kern der Umsetzung von #891: das Speichern muss "der Nutzer hat
  // ausdruecklich KEINE eigene Farbe gewaehlt" von "der Nutzer hat die Farbe gar
  // nicht angefasst" unterscheiden koennen. Beide sind falsy - haetten sie
  // denselben Wert, wuerde das Abwaehlen einer Farbe entweder verschluckt (bei
  // COALESCE im Backend) oder es wuerde jedes Speichern die Farbe loeschen.
  const { colorToSave } = calendarHelpers;
  const termin = { color: '#8156C0' };

  assert(colorToSave('', termin) === null,
    'der Erben-Swatch loescht die eigene Farbe des Termins');
  assert(colorToSave(undefined, termin) === '#8156C0',
    'kein aktiver Swatch laesst sie dagegen stehen - derselbe falsy-Wert, andere Bedeutung');
  assert(colorToSave('', termin) !== colorToSave(undefined, termin),
    'die beiden Faelle duerfen nie dasselbe Ergebnis liefern');
});

test('sameColor vergleicht Hex-Werte ohne Ruecksicht auf Schreibweise', () => {
  const { sameColor } = calendarHelpers;
  assert(sameColor('#587DCE', '#587dce') === true, 'derselbe Wert, andere Schreibweise');
  assert(sameColor('#587DCE', '#3CA368') === false, 'verschiedene Werte bleiben verschieden');
  assert(sameColor(null, '#587DCE') === false, 'null ist keine Farbe');
  assert(sameColor(undefined, undefined) === false, 'undefined auch nicht');
});

// Additiv zu Muster/Override, nie ein Ersatz (server/routes/schedule-extras.js)
// - die Ueberlagerung rendert schon ein Chip je Eintrag (kein Dedup-Risiko,
// siehe die Untersuchung dazu), aber ohne diese Kennzeichnung waere Bereitschaft
// neben einer regulaeren Schicht optisch nicht von einem zweiten Haupttermin
// zu unterscheiden.
test('ein Extra-Eintrag traegt eine eigene Kennzeichnung im Kalender-Chip und in seinem Titel, ein primaerer Eintrag nicht', () => {
  const { renderScheduleChip, scheduleEntryTitle } = calendarHelpers;
  const type = { name: 'Fruehschicht', short_code: 'F', color: '#6C3AED', start_time: '06:00', end_time: '14:00' };
  const primary = { user_id: 1, source: 'override', shift_type: type };
  const extra = { user_id: 1, source: 'extra', shift_type: type };

  assert(!renderScheduleChip(primary).includes('schedule-entry__extra-badge'), 'ein primaerer Eintrag bekommt kein Extra-Abzeichen');
  assert(renderScheduleChip(extra).includes('schedule-entry__extra-badge'), 'ein Extra bekommt sein Abzeichen im Chip');
  assert(!scheduleEntryTitle(primary).includes('extraBadgeLabel'), 'der Titel eines primaeren Eintrags nennt das Extra-Etikett nicht');
  assert(scheduleEntryTitle(extra).includes('extraBadgeLabel'), 'der Titel eines Extras nennt es beim Namen, auch ohne sichtbares Abzeichen (Tooltip fuer die enge Monatszelle)');
});

// --------------------------------------------------------
// nextOccurrence: MONTHLY ueber kurze Monate
//
// Die Klemmung stand hinter dem Monatswechsel statt davor, und ein 31. Februar
// rollt in JavaScript still auf den 3. Maerz. Damit griff die Korrektur nie:
// der kurze Monat fiel nicht auf seinen letzten Tag, er fiel ganz aus.
//
// Geprueft wird deshalb die REGEL, nicht die Datumsliste: eine monatliche Serie
// besucht jeden Monat genau einmal. Eine Liste erwarteter Daten waere beim
// naechsten Randfall wieder nur eine Liste - die Regel bricht bei jedem
// ausgefallenen Monat, egal an welchem Tag er haengt.
// --------------------------------------------------------

/** Die naechsten n Vorkommen ab (ausschliesslich) `start`. */
function occurrences(start, rule, n, opts = undefined) {
  const out = [];
  let d = start;
  for (let i = 0; i < n; i++) {
    d = nextOccurrence(d, rule, opts);
    if (!d) break;
    out.push(d);
  }
  return out;
}

/** Fortlaufender Monatsindex - macht den Jahreswechsel zu einem Schritt wie jeder andere. */
function monthIndex(dateKey) {
  return Number(dateKey.slice(0, 4)) * 12 + Number(dateKey.slice(5, 7));
}

test('nextOccurrence: MONTHLY laesst keinen Monat aus, egal an welchem Tag die Serie haengt', () => {
  for (const day of ['28', '29', '30', '31']) {
    const start = `2026-01-${day}`;
    const list = occurrences(start, 'FREQ=MONTHLY', 12);
    assert(list.length === 12, `am ${day}.: zwoelf Vorkommen erwartet, bekommen ${list.length}`);
    // NICHT die Zahl der verschiedenen Monate zaehlen: ueber zwei Jahre hinweg
    // sind auch die Monate einer Serie, die jeden Februar ueberspringt, alle
    // verschieden. Die Regel ist der lueckenlose SCHRITT - jedes Vorkommen liegt
    // genau einen Kalendermonat nach dem vorigen.
    const steps = [start, ...list].map(monthIndex);
    for (let i = 1; i < steps.length; i++) {
      assert(steps[i] - steps[i - 1] === 1,
        `am ${day}.: Sprung von ${[start, ...list][i - 1]} nach ${[start, ...list][i]} ueberspringt einen Monat`);
    }
  }
});

test('nextOccurrence: MONTHLY klemmt auf den letzten Tag des kurzen Monats', () => {
  assert(nextOccurrence('2026-01-31', 'FREQ=MONTHLY') === '2026-02-28', '31. Januar → 28. Februar (2026 kein Schaltjahr)');
  assert(nextOccurrence('2024-01-31', 'FREQ=MONTHLY') === '2024-02-29', 'im Schaltjahr auf den 29.');
  assert(nextOccurrence('2026-03-31', 'FREQ=MONTHLY') === '2026-04-30', '31. Maerz → 30. April, wie der Kommentar es immer versprochen hat');
});

test('nextOccurrence: MONTHLY haelt seinen Takt auch ueber kurze Monate', () => {
  // Der uebersprungene Monat verschob vorher den Rhythmus: vom 31. Juli ging es
  // drei Monate weiter statt zwei.
  const rule = 'FREQ=MONTHLY;INTERVAL=2';
  const list = occurrences('2026-01-31', rule, 5);
  const months = list.map((d) => Number(d.slice(5, 7)));
  assert(months.join(',') === '3,5,7,9,11', `Zweimonatstakt erwartet 3,5,7,9,11 - bekommen ${months.join(',')}`);
});

test('nextOccurrence: MONTHLY rechnet ueber den Jahreswechsel', () => {
  assert(nextOccurrence('2026-12-31', 'FREQ=MONTHLY') === '2027-01-31', 'Dezember → Januar des Folgejahres');
  assert(nextOccurrence('2026-11-30', 'FREQ=MONTHLY;INTERVAL=3') === '2027-02-28', 'drei Monate weiter, geklemmt');
});

// --------------------------------------------------------
// BYMONTHDAY=-1 und der Anker (#960, #978)
//
// Beide Faelle haben dieselbe Ursache: der gemeinte Tag wurde aus dem VORIGEN
// Vorkommen abgeleitet, und weil ein kurzer Monat ihn klemmt, war er danach ein
// anderer. Zwei Wege heraus - die Regel traegt ihn, oder der Aufrufer.
// --------------------------------------------------------

test('nextOccurrence: BYMONTHDAY=-1 trifft in jedem Monat dessen letzten Tag', () => {
  const rule = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  const list = occurrences('2026-01-31', rule, 12);
  assert(list.length === 12, `zwoelf Vorkommen erwartet, bekommen ${list.length}`);
  for (const d of list) {
    const [y, m, day] = d.split('-').map(Number);
    const letzter = new Date(Date.UTC(y, m, 0)).getUTCDate();
    assert(day === letzter, `${d} ist nicht der letzte Tag des Monats (${letzter}.)`);
  }
});

test('nextOccurrence: das naechste Vorkommen kann im SELBEN Monat liegen', () => {
  // Die Regel ist eine Aussage, kein Nebenprodukt des Startdatums: wer sie
  // setzt, meint den letzten Tag, auch wenn er am 15. angelegt hat.
  //
  // DIESER TEST HIELT DAS FALSCHE ERGEBNIS FEST. Er erwartete den 28. Februar
  // und beschrieb damit genau den Fehler: vom 15. Januar aus ist das naechste
  // Vorkommen der 31. Januar, nicht der Monatsletzte des Folgemonats. So fiel
  // der 31. Januar ganz aus, sobald DTSTART nicht selbst auf der Regel lag.
  assert(nextOccurrence('2026-01-15', 'FREQ=MONTHLY;BYMONTHDAY=-1') === '2026-01-31',
    'der Monatsletzte des BASISMONATS, solange er noch bevorsteht');
  assert(nextOccurrence('2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=-1') === '2026-02-28',
    'steht er schon hinter uns, kommt der naechste Monat');
  // Mit Intervall bleibt der Sprung erhalten, sobald der Basismonat erledigt ist.
  assert(nextOccurrence('2026-01-31', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1') === '2026-04-30');
});

test('nextOccurrence: der Anker haelt den gemeinten Tag ueber kurze Monate hinweg', () => {
  // Ohne Anker schreibt die Klemmung sich fest - das ist der Rest, den der
  // Monatsfix in v2.60.0 stehen liess.
  const ohne = occurrences('2026-01-31', 'FREQ=MONTHLY', 6);
  const mit  = occurrences('2026-01-31', 'FREQ=MONTHLY', 6, { anchor: '2026-01-31' });
  // occurrences() liefert die Vorkommen NACH dem Start: [0] ist der Februar.
  assert(ohne[0] === '2026-02-28' && mit[0] === '2026-02-28',
    'der kurze Monat wird in beiden Faellen geklemmt, nicht uebersprungen');
  assert(ohne[1] === '2026-03-28', `ohne Anker bleibt die Klemmung: ${ohne[1]}`);
  assert(mit[1] === '2026-03-31', `mit Anker kehrt der 31. zurueck: ${mit[1]}`);
});

test('nextOccurrence: eine jaehrliche Serie am 29. Februar kehrt im Schaltjahr zurueck (#978)', () => {
  const mit = occurrences('2024-02-29', 'FREQ=YEARLY', 4, { anchor: '2024-02-29' });
  assert(mit[0] === '2025-02-28', 'im Nicht-Schaltjahr geklemmt');
  assert(mit[3] === '2028-02-29', `2028 ist ein Schaltjahr, bekommen ${mit[3]}`);

  // Ohne Anker bleibt es beim bisherigen Verhalten - Aufgabenserien kennen
  // ihren Ursprung nicht und duerfen sich davon nicht aendern.
  const ohne = occurrences('2024-02-29', 'FREQ=YEARLY', 4);
  assert(ohne[3] === '2028-02-28', `ohne Anker unveraendert, bekommen ${ohne[3]}`);
});

test('nextOccurrence: ein unlesbarer Anker aendert nichts', () => {
  const ohne = nextOccurrence('2026-01-31', 'FREQ=MONTHLY');
  assert(nextOccurrence('2026-01-31', 'FREQ=MONTHLY', { anchor: 'gestern' }) === ohne,
    'ein kaputter Anker faellt auf das bisherige Verhalten zurueck, statt NaN zu liefern');
});

// --------------------------------------------------------
// Was der Review zu #960 gefunden hat
// --------------------------------------------------------

test('nextOccurrence: gelesen wird NUR -1 bei MONTHLY, alles andere bleibt unbedient', () => {
  // DIE ERSTE FASSUNG LAS DEN GANZEN RFC-BEREICH, "weil Fremdkalender ihn
  // liefern" - und machte damit sieben Fehlerfaelle auf, die sie nicht bedienen
  // konnte. `BYMONTHDAY=31` muesste im Februar AUSFALLEN statt zu klemmen,
  // `1,15` meint zwei Tage im Monat, `FREQ=YEARLY;BYMONTHDAY=-1` meint zwoelf
  // Vorkommen im Jahr, und bei DAILY/WEEKLY filtert es Tage statt sie zu
  // setzen. Was diese Funktion nicht ausdruecken kann, nimmt sie nicht an: eine
  // ignorierte Angabe laesst die Serie auf ihrem DTSTART-Tag, eine falsch
  // gerechnete verschiebt jeden Termin.
  const ohneRegel = nextOccurrence('2026-01-15', 'FREQ=MONTHLY');
  for (const wert of ['-2', '-31', '15', '31', '1,15', '0']) {
    assert(nextOccurrence('2026-01-15', `FREQ=MONTHLY;BYMONTHDAY=${wert}`) === ohneRegel,
      `BYMONTHDAY=${wert} muss unbedient bleiben, nicht still gerechnet werden`);
  }
  // Und nur bei MONTHLY bedeutet die Angabe ueberhaupt etwas.
  assert(nextOccurrence('2026-01-15', 'FREQ=YEARLY;BYMONTHDAY=-1')
    === nextOccurrence('2026-01-15', 'FREQ=YEARLY'), 'jaehrlich meint etwas anderes');
  assert(nextOccurrence('2026-01-15', 'FREQ=WEEKLY;BYMONTHDAY=-1')
    === nextOccurrence('2026-01-15', 'FREQ=WEEKLY'), 'woechentlich erst recht');

  // Reichweite: die eine unterstuetzte Form wirkt.
  assert(nextOccurrence('2026-01-15', 'FREQ=MONTHLY;BYMONTHDAY=-1') === '2026-01-31');
});

test('nextOccurrenceAfter: COUNT gilt fuer eine -1-Serie, ohne sie abzuschneiden', () => {
  // Die Grenze GANZ abzuschalten war die falsche Antwort auf den Abschneide-
  // Fehler: dann lief eine Serie mit COUNT=1 fuer immer weiter.
  const q = (rule, ab) => nextOccurrenceAfter('2026-01-15', rule, ab, { seriesStart: '2026-01-15' });
  assert(q('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '2026-03-01') === '2026-03-31',
    'das letzte Vorkommen bleibt erhalten');
  assert(q('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '2026-04-01') === null,
    'danach ist die Serie vorbei');
  assert(q('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=1', '2027-01-01') === null,
    'DTSTART ist Vorkommen 1 - eine Serie mit COUNT=1 ist danach zu Ende');
  assert(q('FREQ=MONTHLY;BYMONTHDAY=-1', '2027-01-01') === '2027-01-31',
    'ohne COUNT laeuft sie weiter');
});

test('nextOccurrence: ein unlesbarer Anker wirft auch bei YEARLY nicht', () => {
  // Eine Invalid Date ist ein truthy Objekt: der YEARLY-Zweig nahm sie als
  // Anker, `getUTCMonth()` ergab NaN, und `toISOString()` brach mit RangeError
  // ab - genau das, was der Guard verhindern soll. Der vorige Fallback-Test
  // deckte nur MONTHLY.
  const ohne = nextOccurrence('2024-02-29', 'FREQ=YEARLY');
  assert(nextOccurrence('2024-02-29', 'FREQ=YEARLY', { anchor: 'gestern' }) === ohne,
    'faellt auf das bisherige Verhalten zurueck');
  assert(nextOccurrence('2024-02-29', 'FREQ=YEARLY', { anchor: '' }) === ohne);
});

// --------------------------------------------------------
// Das erste Vorkommen einer Regel finden (#960)
//
// LESEND. `seriesStartFor` beantwortet, welcher Tag der erste ist - es
// korrigiert kein gespeichertes Datum. Wer den Beweis fuer die Schreibrouten
// sucht, findet ihn in test-calendar-routes.js und test-tasks-routes.js.
// --------------------------------------------------------

test('seriesStartFor findet das erste Vorkommen', () => {
  const R = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  assert(seriesStartFor('2026-01-15', R) === '2026-01-31', 'der erste Treffer ab dem 15. ist der Monatsletzte');
  assert(seriesStartFor('2026-01-31', R) === '2026-01-31', 'wer schon passt, bleibt');
  // Die Uhrzeit bleibt Wanduhrzeit - nur der Tag wandert.
  assert(seriesStartFor('2026-01-15T09:30:00', R) === '2026-01-31T09:30:00');
});

test('seriesStartFor laesst alles andere in Ruhe', () => {
  // BYDAY ist ausdruecklich ausgenommen: Apple serialisiert "jeden Werktag" als
  // Serie, deren Start auf ein Wochenende fallen kann, und die Expansion
  // ueberspringt ihn (#549). Diese Entscheidung ist aelter und gilt weiter.
  assert(seriesStartFor('2026-05-09', 'FREQ=WEEKLY;BYDAY=MO') === '2026-05-09');
  assert(seriesStartFor('2026-01-15', 'FREQ=MONTHLY') === '2026-01-15', 'ohne die Angabe nichts');
  assert(seriesStartFor('2026-01-15', null) === '2026-01-15', 'ohne Regel nichts');
  assert(seriesStartFor(null, 'FREQ=MONTHLY;BYMONTHDAY=-1') === null, 'ohne Datum nichts');
  assert(seriesStartFor('kaputt', 'FREQ=MONTHLY;BYMONTHDAY=-1') === 'kaputt', 'unlesbar bleibt unlesbar');
});

test('lastOccurrenceOf: COUNT=1 bezieht sich auf das erste VORKOMMEN, nicht auf DTSTART', () => {
  // DTSTART ist nur dann Vorkommen 1, wenn es auf der Regel liegt. Bei einem
  // unsynchronisierten Start (15. Januar) ist das erste Vorkommen der 31., und
  // eine Grenze auf dem 15. wies genau dieses eine ab: eine Serie mit COUNT=1
  // verschwand, sobald DTSTART vorbei war, obwohl die Expansion sie lieferte.
  const q = (ab) => nextOccurrenceAfter('2026-01-15', 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=1', ab,
    { seriesStart: '2026-01-15' });
  assert(q('2026-01-20') === '2026-01-31', `das eine Vorkommen bleibt: ${q('2026-01-20')}`);
  assert(q('2026-02-05') === null, 'danach ist die Serie vorbei');
});

test('seriesStartFor sucht weiter, bis ALLE Filter passen', () => {
  // `BYMONTHDAY=-1` mit `BYDAY=MO` ist gueltig und meint die Schnittmenge: der
  // erste Monatsletzte kann ein Samstag sein. Ein einzelner Schritt lieferte
  // wieder ein Datum, das seine eigene Regel verfehlt - derselbe Fehler, gegen
  // den diese Funktion gebaut ist, nur eine Runde spaeter.
  const treffer = seriesStartFor('2026-01-15', 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1');
  const d = new Date(`${treffer}T00:00:00Z`);
  assert(d.getUTCDay() === 1, `${treffer} muss ein Montag sein`);
  const letzter = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  assert(d.getUTCDate() === letzter, `${treffer} muss der Monatsletzte sein`);
});

test('nextOccurrenceAfter holt auf, bis ALLE Filter passen', () => {
  // GEGENSTUECK ZUM TEST DARUEBER, UND ZWAR DAS NOETIGE: `seriesStartFor` fand
  // den ersten Treffer bereits richtig - direkt danach verlor der Countdown den
  // BYDAY-Filter wieder, weil `nextOccurrence` bei `BYMONTHDAY=-1` nur von
  // Monatsletztem zu Monatsletztem springt. Die Kalender-Expansion filtert
  // zusaetzlich, der Countdown nicht: dieselbe Serie, zwei Antworten.
  const R = 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1';
  const start = '2026-01-15';
  const erster = seriesStartFor(start, R);
  const treffer = nextOccurrenceAfter(erster, R, '2026-09-01', { seriesStart: start });
  assert(treffer, 'die Serie laeuft weiter');
  const d = new Date(`${treffer}T00:00:00Z`);
  assert(d.getUTCDay() === 1, `${treffer} muss ein Montag sein`);
  const letzter = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  assert(d.getUTCDate() === letzter, `${treffer} muss der Monatsletzte sein`);
  // UND DIESELBE ANTWORT WIE DIE EXPANSION. Der eigentliche Schaden war nicht
  // das falsche Datum an sich, sondern dass Kachel und Kalender auseinanderliefen.
  let lauf = erster;
  let expandiert = null;
  for (let i = 0; i < 60; i++) {
    const n = nextOccurrence(lauf, R);
    if (!n || n <= lauf) break;
    lauf = n;
    if (lauf >= '2026-09-01' && matchesRRuleByday(lauf, R)) { expandiert = lauf; break; }
  }
  assert(treffer === expandiert,
    `Countdown ${treffer} muss der Expansion ${expandiert} folgen`);
});

test('matchesRRuleByday filtert nicht, wo UTC- und Ortsdatum auseinanderfallen', () => {
  // Ein Termin am 31. Januar um 20:00 New Yorker Zeit liegt in UTC schon am
  // 1. Februar. Die Pruefung saehe dort den ersten statt des letzten Tages und
  // wuerfe das Vorkommen still weg.
  const R = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  assert(matchesRRuleByday('2026-02-01', R) === false, 'ohne Zonenhinweis wird gefiltert');
  assert(matchesRRuleByday('2026-02-01', R, { utcDiffersFromLocal: true }) === true,
    'mit Zonenhinweis nicht - lieber ein Vorkommen zu viel als eines lautlos verloren');
});

test('scheduleEntriesOnDay() respektiert den Personenfilter und den "Mir zugewiesen"-Filter wie Termine/Aufgaben (#1018)', () => {
  const { scheduleEntriesOnDay, state } = calendarHelpers;
  const savedEntries = state.scheduleEntries;
  const savedLayer = state.layerSchedule;
  const savedPeople = state.people;
  const savedAssignedToMe = state.assignedToMe;
  const savedCurrentUserId = state.currentUserId;
  try {
    state.layerSchedule = true;
    state.scheduleEntries = [
      { date_key: '2026-09-10', shift_type: { name: 'Fruehschicht' }, user_id: 1 },
      { date_key: '2026-09-10', shift_type: { name: 'Spaetschicht' }, user_id: 2 },
    ];

    state.people = new Set();
    state.assignedToMe = false;
    assert(scheduleEntriesOnDay('2026-09-10').length === 2,
      'ohne aktiven Filter zeigt der Kalender beide Personen');

    state.people = new Set([1]);
    assert(scheduleEntriesOnDay('2026-09-10').length === 1
      && scheduleEntriesOnDay('2026-09-10')[0].user_id === 1,
      'Personenfilter auf Person 1 muss Person 2s Schicht ausblenden - vorher zeigte der Schichtplan trotz aktivem Filter alle Personen');

    state.people = new Set();
    state.assignedToMe = true;
    state.currentUserId = 2;
    assert(scheduleEntriesOnDay('2026-09-10').length === 1
      && scheduleEntriesOnDay('2026-09-10')[0].user_id === 2,
      '"Mir zugewiesen" muss auch fuer den Schichtplan gelten, nicht nur fuer Termine/Aufgaben');
  } finally {
    state.scheduleEntries = savedEntries;
    state.layerSchedule = savedLayer;
    state.people = savedPeople;
    state.assignedToMe = savedAssignedToMe;
    state.currentUserId = savedCurrentUserId;
  }
});

test('Geburtstage ueberleben den Personenfilter und "Mir zugewiesen" - sie sind eine Ebene, keine Zuweisung (#1054)', () => {
  const { eventsOnDay, passesPersonFilters, state } = calendarHelpers;
  const saved = {
    events: state.events, people: state.people, assignedToMe: state.assignedToMe,
    currentUserId: state.currentUserId, layerBirthdays: state.layerBirthdays,
  };
  const DAY = '2026-09-10';
  const idsOn = (day) => eventsOnDay(day).map((e) => e.id);
  try {
    state.layerBirthdays = true;
    state.events = [
      // So legt server/services/birthdays.js einen Geburtstag an: ohne Zuweisung.
      { id: 1, title: 'Anna', birthday_name: 'Anna', start_datetime: DAY, all_day: 1, assigned_users: [] },
      { id: 2, title: 'Zahnarzt', start_datetime: `${DAY}T09:00:00`, assigned_users: [{ id: 1 }] },
      { id: 3, title: 'Elternabend', start_datetime: `${DAY}T19:00:00`, assigned_users: [] },
    ];

    state.people = new Set();
    state.assignedToMe = false;
    assert(idsOn(DAY).length === 3, 'ohne aktiven Filter zeigt der Tag alle drei');

    state.people = new Set([1]);
    const gefiltert = idsOn(DAY);
    assert(gefiltert.includes(1),
      'der Geburtstag muss bei aktiver Personenauswahl stehen bleiben - vorher verschwand er mit jeder Auswahl, weil er nie eine Zuweisung traegt (#1054)');
    assert(gefiltert.includes(2) && !gefiltert.includes(3),
      'gewoehnliche Termine folgen weiter der Zuweisung: der Termin ohne Person faellt heraus, das ist Absicht (#987)');

    state.people = new Set();
    state.assignedToMe = true;
    state.currentUserId = 2;
    const meine = idsOn(DAY);
    assert(meine.includes(1) && !meine.includes(2) && !meine.includes(3),
      '"Mir zugewiesen" laesst den Geburtstag ebenfalls stehen und nimmt nur fremde Termine weg');

    state.assignedToMe = false;
    state.layerBirthdays = false;
    assert(!eventsOnDay(DAY).some((e) => e.birthday_name),
      'ausblenden tut ihn allein seine Ebene - der Schalter im Filterblatt bleibt der eine Weg');

    // Das Praedikat selbst, damit der Guard auch den Tagesindex-Pfad abdeckt,
    // der dieselbe Funktion auf die vorgebauten Buckets anwendet.
    state.layerBirthdays = true;
    state.people = new Set([1]);
    assert(passesPersonFilters({ birthday_name: 'Anna', assigned_users: [] }) === true,
      'passesPersonFilters() nimmt den Ebenen-Eintrag von beiden Personen-Achsen aus');
    assert(passesPersonFilters({ title: 'ohne Person', assigned_users: [] }) === false,
      'ein Termin ohne Zuweisung faellt unveraendert heraus');
  } finally {
    state.events = saved.events;
    state.people = saved.people;
    state.assignedToMe = saved.assignedToMe;
    state.currentUserId = saved.currentUserId;
    state.layerBirthdays = saved.layerBirthdays;
  }
});

test('getWeekRange: Desktop bleibt beim reinen 7-Tage-Raster (#1006)', () => {
  const { from, to } = calendarHelpers.getWeekRange('2026-03-11', { weekStart: 1, mobile: false });
  assert(from === '2026-03-09' && to === '2026-03-15',
    `Desktop-Woche darf sich nicht erweitern: ${from}..${to}`);
});

test('getWeekRange: Mobile mitten in der Woche erweitert das Ladefenster nicht unnötig (#1006)', () => {
  // Mittwoch: das 3-Tage-Fenster (Di-Do) liegt vollständig innerhalb der
  // Montag-Woche - die Vereinigung darf hier gleich dem Desktop-Raster bleiben.
  const { from, to } = calendarHelpers.getWeekRange('2026-03-11', { weekStart: 1, mobile: true });
  assert(from === '2026-03-09' && to === '2026-03-15',
    `Ein Mittwochs-Cursor braucht keine Erweiterung: ${from}..${to}`);
});

test('getWeekRange: Montag-Woche + Sonntags-Cursor schliesst den folgenden Montag ein (#1006)', () => {
  // Sonntag ist der letzte Tag der Montag-Woche; das Mobile-Fenster (Sa-Mo)
  // ragt einen Tag darüber hinaus - genau der Tag, den buildDayIndex() vorher
  // stillschweigend wegklammerte.
  const { from, to } = calendarHelpers.getWeekRange('2026-03-15', { weekStart: 1, mobile: true });
  assert(from === '2026-03-09' && to === '2026-03-16',
    `Der folgende Montag muss mitgeladen werden: ${from}..${to}`);
});

test('getWeekRange: Sonntag-Woche + Samstags-Cursor schliesst den folgenden Sonntag ein (#1006)', () => {
  // Dieselbe Randsituation am anderen Wochenstart: Samstag ist hier der
  // letzte Tag, das Mobile-Fenster ragt in den folgenden Sonntag hinein.
  const { from, to } = calendarHelpers.getWeekRange('2026-03-14', { weekStart: 0, mobile: true });
  assert(from === '2026-03-08' && to === '2026-03-15',
    `Der folgende Sonntag muss mitgeladen werden: ${from}..${to}`);
});

test('getWeekRange: Montag-Woche + Montags-Cursor schliesst den vorherigen Sonntag ein (#1006)', () => {
  // Symmetrischer Fall am linken Rand: Montag ist der erste Tag der Woche,
  // das Mobile-Fenster ragt einen Tag in die vorherige Woche hinein.
  const { from, to } = calendarHelpers.getWeekRange('2026-03-09', { weekStart: 1, mobile: true });
  assert(from === '2026-03-08' && to === '2026-03-15',
    `Der vorherige Sonntag muss mitgeladen werden: ${from}..${to}`);
});

test('getRangeForView: Der echte Week-Aufrufer liest matchMedia und reicht mobile weiter (#1030)', () => {
  // Die fünf getWeekRange()-Tests oben beweisen nur die Arithmetik, nachdem
  // `mobile` schon feststeht. Wenn der echte Aufrufer aufhört, das Flag zu
  // liefern (z.B. `return getWeekRange(cursor)` ohne Optionen), blieben sie
  // trotzdem grün - dieser Test prüft die fehlende Verbindung.
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    const mobile = calendarHelpers.getRangeForView('week', '2026-03-15');
    assert(mobile.from === '2026-03-09' && mobile.to === '2026-03-16',
      `Mobile-Aufrufer muss das erweiterte Fenster laden: ${mobile.from}..${mobile.to}`);

    globalThis.window = { matchMedia: () => ({ matches: false }) };
    const desktop = calendarHelpers.getRangeForView('week', '2026-03-15');
    assert(desktop.from === '2026-03-09' && desktop.to === '2026-03-15',
      `Desktop-Aufrufer darf sich nicht erweitern: ${desktop.from}..${desktop.to}`);
  } finally {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
});

// --------------------------------------------------------
// Monatszelle am Telefon: Punkte oder Titelzeilen (Schalter im Filter-Blatt)
// --------------------------------------------------------

test('Monatsflaeche traegt die Titel-Modifier-Klasse nur, wenn der Schalter an ist', () => {
  assert(calendarHelpers.monthViewClasses(false) === 'month-view',
    'aus heisst: keine zweite Klasse, also exakt die Basisfassung');
  assert(calendarHelpers.monthViewClasses(true).split(' ').includes('month-view--titles'),
    'an heisst: die Modifier-Klasse, an der die 639er-Query haengt');
  assert(calendarHelpers.monthViewClasses(true).split(' ').includes('month-view'),
    'die Basisklasse bleibt - sie traegt Flex-Richtung und Ueberlauf der Flaeche');
});

// DER LEERE STRING IST DER FALL, DER ZAEHLT: getPropertyValue() liefert ihn,
// wo die Property nirgends gesetzt ist, und `parseInt('') > 0` ist NaN > 0.
// Ohne diese Umsetzung stuende dort still `NaN` als Deckel, und Math.min(x, NaN)
// ist NaN - jede Zelle haette am Ende keinen einzigen Chip gezeigt.
test('Der Sichtbarkeits-Deckel liest 0, leer und Unfug alle als "kein Deckel"', () => {
  const { monthDayVisibleCap } = calendarHelpers;
  for (const raw of ['', ' ', '0', 'auto', 'none', '-3']) {
    assert(monthDayVisibleCap(raw) === Infinity,
      `${JSON.stringify(raw)} muss "kein Deckel" heissen, war ${monthDayVisibleCap(raw)}`);
  }
  assert(monthDayVisibleCap('4') === 4, 'die gesetzte Zahl gilt');
  assert(monthDayVisibleCap(' 4 ') === 4, 'getPropertyValue liefert den Wert mit Rand-Leerraum');
});

test('Die Titelfassung wohnt in derselben Query wie die Punktfassung', () => {
  const rules = [...eachRule(calendarCss)].filter((r) => r.selector.includes('.month-view--titles'));
  assert(rules.length > 0, '.month-view--titles hat keine einzige Regel - der Schalter waere folgenlos');
  for (const rule of rules) {
    assert(rule.at.some((a) => /max-width:\s*639px/.test(a)),
      `${rule.selector.trim()} steht ausserhalb der 639er-Query - auf dem Desktop zeigt die `
      + 'Monatszelle ohnehin Titel, eine Regel dort aendert nur, was schon stimmt');
  }
});

// Die Punktfassung ist die VORGABE und muss es bleiben: waere sie unbedingt
// geschnitten, gaebe der Schalter die Titelzeilen nie frei; waere sie ganz weg,
// haette das Update jedes Telefon ungefragt umgebaut.
test('Die Punktfassung gilt genau dann, wenn die Titelfassung nicht gewaehlt ist', () => {
  const dotRules = [...eachRule(calendarCss)].filter((r) =>
    /border-radius:\s*var\(--radius-full\)/.test(r.body)
    && r.selector.includes('.month-day')
    && r.at.some((a) => /max-width:\s*639px/.test(a)));
  assert(dotRules.length > 0, 'die Punktgeometrie der Monatszelle ist verschwunden');
  for (const rule of dotRules) {
    assert(rule.selector.includes(':not(.month-view--titles)'),
      `${rule.selector.trim()} macht Punkte ohne die Bedingung - der Schalter kaeme nie gegen sie an`);
  }
});

// Der Klipp-Guard MUSS jede Fassungsregel ueberwiegen, die `display` setzt.
// Bei Gleichstand gewinnt die spaetere Regel, und die Fassungen stehen weiter
// unten in der Datei - ein geklippter Chip waere wieder sichtbar, waehrend das
// "+N" darunter ihn weiterzaehlt. Genau so ist es beim Bau dieses Schalters
// passiert: `:not(.month-view--titles)` zaehlt sein Argument mit, und mit dem
// urspruenglichen `.month-day` davor stand die Punktfassung selbst auf vier.
//
// GEZAEHLT WIRD NUR, WER `display` SETZT. Die erste Fassung dieses Guards nahm
// jede Regel mit der Modifier-Klasse und stolperte ueber
// `.month-view--titles .cal-task-chip .priority-dot` - vier Klassen, aber sie
// setzt eine Breite auf einem ANDEREN Element und kann mit dem Klipp-Guard nie
// kollidieren. Ein Guard, der solche Regeln mitzaehlt, erzwingt eine
// Spezifitaets-Ruestung gegen einen Konflikt, den es nicht gibt.
test('Der Klipp-Guard steht ueber jeder Fassungsregel, die display setzt', () => {
  const clip = [...eachRule(calendarCss)].find((r) => r.selector.includes('.is-clipped')
    && r.selector.includes('.month-day'));
  assert(clip, 'die .is-clipped-Regel des Monatsrasters fehlt');
  // Spezifitaet zaehlt das :not()-Argument mit - deshalb einfach alle
  // Klassen-Token des Selektors, inklusive derer in der Klammer.
  const classes = (sel) => (sel.split(',')[0].match(/\.[a-zA-Z][\w-]*/g) ?? []).length;
  const variant = [...eachRule(calendarCss)].filter((r) =>
    (r.selector.includes('.month-view--titles') || r.selector.includes(':not(.month-view--titles)'))
    && /(?:^|;)\s*display\s*:/.test(r.body));
  assert(variant.length > 0, 'keine Fassungsregel setzt display - dann prueft dieser Guard nichts');
  for (const rule of variant) {
    assert(classes(clip.selector) > classes(rule.selector),
      `.is-clipped traegt ${classes(clip.selector)} Klassen, ${rule.selector.trim()} `
      + `traegt ${classes(rule.selector)} - bei Gleichstand gewinnt die spaetere Regel, `
      + 'und das ist die Fassung');
  }
});

// Schichtplan-Bloecke im Zeitraster: Ueberlappungs-Layout (#1043)
//
// Vorher bekam JEDER Schichtplan-Block dieselben festen Aussenraender
// (renderScheduleTimeBlock() kannte gar kein Layout) - zwei Schichten mit
// gleichem oder ueberlappendem Zeitfenster lagen deckungsgleich uebereinander,
// und nur die spaeter gerenderte war ueberhaupt zu sehen/anzuklicken. Diese
// Tests pruefen dieselbe Ueberlappungs-Arithmetik, die gewoehnliche Termine
// laengst ueber layoutOverlaps() bekommen, jetzt auch fuer Schichtplan-Bloecke
// (layoutScheduleBlocks()) - inklusive des Falls, dass zwei Eintraege
// inhaltlich identisch sind (derselbe Schichttyp, dieselbe Zeit), aber zwei
// verschiedene sichtbare Instanzen bleiben (Muster + Extra-Schicht, #1043).
// --------------------------------------------------------

function scheduleEntry({ start, end, name = 'Schicht', color = '#3B82F6' } = {}) {
  return {
    user_id: null,
    date_key: '2026-09-06',
    source: 'pattern',
    shift_type_id: 1,
    shift_type: { id: 1, name, short_code: null, start_time: start, end_time: end, color },
  };
}

test('scheduleBlockTimeRange: eine Nachtschicht laeuft bis Tagesende', () => {
  const overnight = scheduleEntry({ start: '22:00', end: '06:00' });
  const range = calendarHelpers.scheduleBlockTimeRange(overnight);
  assert(range.start === 22 * 60 && range.end === 24 * 60,
    `Nachtschicht muss am Tagesende enden, nicht rueckwaerts laufen: ${JSON.stringify(range)}`);
});

test('layoutScheduleBlocks: gleicher Start, unterschiedliches Ende bekommt zwei Spalten (#1043)', () => {
  const basti = scheduleEntry({ start: '08:00', end: '12:00', name: 'Schultag Basti' });
  const emma = scheduleEntry({ start: '08:00', end: '12:45', name: 'Schultag Emma' });
  const layout = calendarHelpers.layoutScheduleBlocks([basti, emma]);
  const a = layout.get(basti);
  const b = layout.get(emma);
  assert(a && b, 'beide Eintraege muessen ein Layout bekommen');
  assert(a.totalCols === 2 && b.totalCols === 2,
    `der gemeldete Fall (08:00-12:00 / 08:00-12:45) muss zwei Spalten teilen: ${a.totalCols}/${b.totalCols}`);
  assert(a.colIndex !== b.colIndex, 'gleich startende, ueberlappende Bloecke duerfen keine gemeinsame Spalte bekommen');
});

test('layoutScheduleBlocks: ein Block, der endet, wo der naechste beginnt, teilt sich eine Spalte (halboffenes Intervall)', () => {
  const first = scheduleEntry({ start: '08:00', end: '10:00' });
  const second = scheduleEntry({ start: '10:00', end: '12:00' });
  const layout = calendarHelpers.layoutScheduleBlocks([first, second]);
  assert(layout.get(first).totalCols === 1 && layout.get(second).totalCols === 1,
    'sich beruehrende, aber nicht ueberlappende Bloecke muessen die volle Breite behalten koennen');
});

test('layoutScheduleBlocks: teilweise ueberlappende Bloecke teilen sich eine Gruppe', () => {
  const first = scheduleEntry({ start: '08:00', end: '10:00' });
  const second = scheduleEntry({ start: '09:00', end: '11:00' });
  const layout = calendarHelpers.layoutScheduleBlocks([first, second]);
  assert(layout.get(first).totalCols === 2 && layout.get(second).totalCols === 2,
    'schon eine Stunde Ueberschneidung reicht fuer eine gemeinsame Gruppe');
  assert(layout.get(first).colIndex !== layout.get(second).colIndex);
});

test('layoutScheduleBlocks: drei gleichzeitige Schichten bekommen stabile, kollisionsfreie Plaetze', () => {
  const a = scheduleEntry({ start: '08:00', end: '12:00' });
  const b = scheduleEntry({ start: '08:00', end: '11:00' });
  const c = scheduleEntry({ start: '09:00', end: '13:00' });
  const layout = calendarHelpers.layoutScheduleBlocks([a, b, c]);
  const cols = [layout.get(a).colIndex, layout.get(b).colIndex, layout.get(c).colIndex];
  assert(layout.get(a).totalCols === 3 && layout.get(b).totalCols === 3 && layout.get(c).totalCols === 3,
    `drei sich ueberlappende Eintraege muessen sich drei Spalten teilen: ${layout.get(a).totalCols}`);
  assert(new Set(cols).size === 3, `alle drei Spaltenindizes muessen verschieden sein: ${cols}`);
});

test('layoutScheduleBlocks: gleicher Schichttyp und gleiche Zeit bleiben zwei eigene Instanzen (Muster + Extra-Schicht, #1043)', () => {
  const pattern = scheduleEntry({ start: '08:00', end: '12:00' });
  const extra = scheduleEntry({ start: '08:00', end: '12:00' });
  extra.source = 'extra';
  const layout = calendarHelpers.layoutScheduleBlocks([pattern, extra]);
  assert(layout.get(pattern) && layout.get(extra), 'beide Objekte muessen unabhaengig voneinander auffindbar sein');
  assert(layout.get(pattern).colIndex !== layout.get(extra).colIndex,
    'inhaltsgleiche Eintraege (gleicher Typ, gleiche Zeit, verschiedene Quelle) duerfen sich trotzdem nicht ueberdecken');
});

test('renderScheduleTimeBlock: ohne Layout bleibt der bisherige volle Balken erhalten (Wochenansicht)', () => {
  const html = calendarHelpers.renderScheduleTimeBlock(scheduleEntry({ start: '08:00', end: '12:00' }), 'week-event');
  assert(html.includes('left:calc(0% + 2px)') && html.includes('width:calc(100% - 4px)'),
    `ein einzelner Block muss die alten Aussenraender behalten: ${html}`);
});

test('renderScheduleTimeBlock: ohne Layout bleibt der bisherige volle Balken erhalten (Tagesansicht)', () => {
  const html = calendarHelpers.renderScheduleTimeBlock(scheduleEntry({ start: '08:00', end: '12:00' }), 'day-event');
  assert(html.includes('left:calc(0% + 4px)') && html.includes('width:calc(100% - 14px)'),
    `ein einzelner Block muss die alten Aussenraender behalten: ${html}`);
});

test('renderScheduleTimeBlock: mit berechnetem Layout bekommt jeder Block seine eigene Spalte (Wochenansicht, #1043)', () => {
  const basti = scheduleEntry({ start: '08:00', end: '12:00' });
  const emma = scheduleEntry({ start: '08:00', end: '12:45' });
  const layout = calendarHelpers.layoutScheduleBlocks([basti, emma]);
  const htmlA = calendarHelpers.renderScheduleTimeBlock(basti, 'week-event', layout.get(basti));
  const htmlB = calendarHelpers.renderScheduleTimeBlock(emma, 'week-event', layout.get(emma));
  assert(!htmlA.includes('width:calc(100% - 4px)') && !htmlB.includes('width:calc(100% - 4px)'),
    'ueberlappende Bloecke duerfen nicht mehr die volle Spaltenbreite bekommen (das war der Bug)');
  assert(htmlA.includes('width:calc(50% - 4px)') && htmlB.includes('width:calc(50% - 4px)'),
    `zwei ueberlappende Bloecke teilen sich je die Haelfte: ${htmlA} / ${htmlB}`);
  const leftA = htmlA.match(/left:calc\(([\d.]+)% \+ 2px\)/)?.[1];
  const leftB = htmlB.match(/left:calc\(([\d.]+)% \+ 2px\)/)?.[1];
  assert(leftA !== undefined && leftB !== undefined && leftA !== leftB,
    `beide Bloecke muessen an unterschiedlicher Stelle beginnen, damit keiner den anderen verdeckt: ${leftA} vs ${leftB}`);
});

test('renderScheduleTimeBlock: mit berechnetem Layout bekommt jeder Block seine eigene Spalte (Tagesansicht, #1043)', () => {
  const basti = scheduleEntry({ start: '08:00', end: '12:00' });
  const emma = scheduleEntry({ start: '08:00', end: '12:45' });
  const layout = calendarHelpers.layoutScheduleBlocks([basti, emma]);
  const htmlA = calendarHelpers.renderScheduleTimeBlock(basti, 'day-event', layout.get(basti));
  const htmlB = calendarHelpers.renderScheduleTimeBlock(emma, 'day-event', layout.get(emma));
  assert(!htmlA.includes('width:calc(100% - 14px)') && !htmlB.includes('width:calc(100% - 14px)'),
    'ueberlappende Bloecke duerfen nicht mehr die volle Spaltenbreite bekommen (das war der Bug)');
  const leftA = htmlA.match(/left:calc\(([\d.]+)% \+ 4px\)/)?.[1];
  const leftB = htmlB.match(/left:calc\(([\d.]+)% \+ 4px\)/)?.[1];
  assert(leftA !== undefined && leftB !== undefined && leftA !== leftB,
    `beide Bloecke muessen an unterschiedlicher Stelle beginnen, damit keiner den anderen verdeckt: ${leftA} vs ${leftB}`);
});

// --------------------------------------------------------
// Schichtplan-Bloecke ueber die echten Ansichts-Aufrufer (#1045 Review-Runde 1)
//
// Die layoutScheduleBlocks()/renderScheduleTimeBlock()-Tests oben beweisen nur,
// dass der Renderer ein mitgegebenes Layout korrekt umsetzt - jeder von ihnen
// holt sich das Layout selbst und reicht es direkt weiter. Keiner prueft, dass
// renderWeekView()/renderDayView() dieses Layout ueberhaupt BERECHNEN und an
// den Renderer WEITERREICHEN. Faellt genau diese Verbindung weg (z.B.
// scheduleLayouts[i].get(entry) durch null ersetzt), bleiben alle bisherigen
// Tests gruen - der urspruengliche Bug (#1043) waere zurueck, obwohl die Suite
// nichts davon meldet. Diese zwei Tests rufen deshalb die echten Aufrufer auf
// und lesen die erzeugten left-Werte aus dem gerenderten HTML.
// --------------------------------------------------------

function fakeDomElement() {
  return {
    addEventListener: () => {},
    getBoundingClientRect: () => ({ height: 1440 }),
    scrollTop: 0,
  };
}

function fakeContainer() {
  let html = '';
  return {
    replaceChildren: () => { html = ''; },
    insertAdjacentHTML: (_position, chunk) => { html += chunk; },
    querySelector: () => fakeDomElement(),
    get html() { return html; },
  };
}

function scheduleBlockLefts(html) {
  return [...html.matchAll(/left:calc\((\d+(?:\.\d+)?)%/g)].map((m) => m[1]);
}

function withOverlappingScheduleState(extra, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const previousState = { ...calendarHelpers.state };
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    Object.assign(calendarHelpers.state, {
      cursor: '2026-09-07',
      today: '2026-09-07',
      weekStart: 1,
      scheduleDisplay: 'blocks',
      layerSchedule: true,
      assignedToMe: false,
      people: new Set(),
      events: [],
      tasks: [],
      holidays: [],
      users: [],
      scheduleEntries: [
        scheduleEntry({ start: '08:00', end: '12:00', name: 'Schultag Basti' }),
        scheduleEntry({ start: '08:00', end: '12:45', name: 'Schultag Emma' }),
      ].map((entry) => ({ ...entry, date_key: '2026-09-07' })),
      ...extra,
    });
    fn();
  } finally {
    Object.assign(calendarHelpers.state, previousState);
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
}

test('renderWeekView: zwei ueberlappende Schichten am selben Tag bekommen unterschiedliche left-Werte (#1045)', () => {
  withOverlappingScheduleState({}, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    const lefts = scheduleBlockLefts(container.html);
    assert(lefts.length === 2, `die Wochenansicht muss beide ueberlappenden Bloecke rendern: ${lefts.length}`);
    assert(lefts[0] !== lefts[1],
      `renderWeekView() muss das berechnete Layout an renderScheduleTimeBlock() weiterreichen, sonst liegen `
      + `beide Bloecke deckungsgleich uebereinander (#1043): ${lefts}`);
  });
});

test('renderDayView: zwei ueberlappende Schichten am selben Tag bekommen unterschiedliche left-Werte (#1045)', () => {
  withOverlappingScheduleState({}, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const lefts = scheduleBlockLefts(container.html);
    assert(lefts.length === 2, `die Tagesansicht muss beide ueberlappenden Bloecke rendern: ${lefts.length}`);
    assert(lefts[0] !== lefts[1],
      `renderDayView() muss das berechnete Layout an renderScheduleTimeBlock() weiterreichen, sonst liegen `
      + `beide Bloecke deckungsgleich uebereinander (#1043): ${lefts}`);
  });
});

test('eventMapUrl: eine Kartensuche nur, wo ein Ortstext uebrig bleibt (#1110)', () => {
  const { eventMapUrl } = calendarHelpers;
  assert(typeof eventMapUrl === 'function', 'eventMapUrl muss ueber __test erreichbar sein');
  const gleich = (ist, soll, was) => assert(ist === soll, `${was}: ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`);
  gleich(
    eventMapUrl('Hauptstraße 5, Berlin'),
    'https://www.openstreetmap.org/search?query=Hauptstra%C3%9Fe%205%2C%20Berlin',
    'Adresse als Suchtext',
  );
  // Zeichen, die eine URL zerlegen koennten, bleiben im Suchtext.
  gleich(
    eventMapUrl('A&B?x=1#2'),
    'https://www.openstreetmap.org/search?query=A%26B%3Fx%3D1%232',
    'URL-Sonderzeichen',
  );
  // Ohne Ort: keine Aktion.
  for (const leer of [null, undefined, '', '   ']) {
    gleich(eventMapUrl(leer), '', `kein Link fuer ${JSON.stringify(leer)}`);
  }
  // NICHT HIER: die ICS-escapte Adresse. Der Browser-Loader ersetzt
  // `/utils/html.js` durch einen Stub, dessen `fmtLocation` die Identitaet ist -
  // ein Fall, der das Aufraeumen braucht, waere hier rot aus dem falschen Grund.
  // Er steht in test:detail-view gegen das echte fmtLocation.
});

// --------------------------------------------------------
// #1064: Filter nach Kalender/Abo und die Achse "Nicht zugewiesen"
// --------------------------------------------------------

/** Den Filterzustand fuer einen Fall setzen und danach zuruecklegen. */
function mitFilterzustand(felder, fn) {
  const { state } = calendarHelpers;
  const vorher = {};
  for (const k of Object.keys(felder)) vorher[k] = state[k];
  Object.assign(state, felder);
  try { return fn(); } finally { Object.assign(state, vorher); }
}

/** localStorage fuer einen Fall - der Browser-Loader stellt keinen bereit. */
function mitSpeicher(eintraege, fn) {
  const vorher = globalThis.localStorage;
  const daten = new Map(Object.entries(eintraege));
  globalThis.localStorage = {
    getItem: (k) => (daten.has(k) ? daten.get(k) : null),
    setItem: (k, v) => daten.set(k, String(v)),
    removeItem: (k) => daten.delete(k),
  };
  try { return fn(daten); } finally { globalThis.localStorage = vorher; }
}

const FILTER_TAG = '2026-09-10';
const FILTER_TERMINE = [
  { id: 1, title: 'Zahnarzt', start_datetime: `${FILTER_TAG}T09:00:00`, assigned_users: [{ id: 1 }] },
  { id: 2, title: 'Training', start_datetime: `${FILTER_TAG}T17:00:00`, assigned_users: [{ id: 2 }],
    calendar_ref_id: 5, cal_name: 'Arbeit', cal_color: '#3366cc' },
  { id: 3, title: 'Muellabfuhr', start_datetime: `${FILTER_TAG}T07:00:00`, assigned_users: [],
    subscription_id: 7, cal_name: 'Abfallkalender', cal_color: '#228844' },
  { id: 4, title: 'Elternabend', start_datetime: `${FILTER_TAG}T19:00:00`, assigned_users: [] },
];
const NUTZER = [{ id: 1 }, { id: 2 }];
const tagesIds = () => calendarHelpers.eventsOnDay(FILTER_TAG).map((e) => e.id).sort((a, b) => a - b).join(',');

test('#1064: "Nicht zugewiesen" ist ein Eintrag der Personenachse', () => {
  const { UNASSIGNED } = calendarHelpers;
  const basis = { events: FILTER_TERMINE, users: NUTZER, assignedToMe: false, hiddenSources: new Map(), layerBirthdays: true };
  mitFilterzustand({ ...basis, people: new Set() }, () => {
    assert(tagesIds() === '1,2,3,4', `ohne Filter alle vier, war ${tagesIds()}`);
  });
  mitFilterzustand({ ...basis, people: new Set([UNASSIGNED]) }, () => {
    assert(tagesIds() === '3,4', `allein gewaehlt zeigt der Eintrag nur die Termine ohne Person, war ${tagesIds()}`);
  });
  mitFilterzustand({ ...basis, people: new Set([1, UNASSIGNED]) }, () => {
    assert(tagesIds() === '1,3,4', `mit einer Person zusammen die Vereinigung, war ${tagesIds()}`);
  });
  mitFilterzustand({ ...basis, people: new Set([1]) }, () => {
    assert(tagesIds() === '1',
      `ein Filter ohne den Eintrag - etwa einer von vor #1064 - laesst Termine ohne Person weiter heraus, war ${tagesIds()}`);
  });
});

test('#1064: eine ausgeblendete Quelle fehlt in jeder Ansicht, und Quelle UND Person wirken zusammen', () => {
  const { passesSourceFilter, eventSourceKey } = calendarHelpers;
  assert(eventSourceKey(FILTER_TERMINE[1]) === 'cal:5', 'CalDAV/Google/Apple ueber calendar_ref_id');
  assert(eventSourceKey(FILTER_TERMINE[2]) === 'sub:7', 'ICS-Abos ueber subscription_id');
  assert(eventSourceKey(FILTER_TERMINE[0]) === null, 'ein eigener Termin hat keine Quelle');

  const basis = { events: FILTER_TERMINE, users: NUTZER, assignedToMe: false, layerBirthdays: true };
  mitFilterzustand({ ...basis, people: new Set(), hiddenSources: new Map([['sub:7', { name: 'Abfallkalender', color: null }]]) }, () => {
    assert(tagesIds() === '1,2,4', `das Abo ist ausgeblendet, der Rest bleibt, war ${tagesIds()}`);
    assert(passesSourceFilter(FILTER_TERMINE[0]) === true, 'ein eigener Termin laesst sich nicht wegschalten');
  });
  mitFilterzustand({ ...basis, people: new Set([calendarHelpers.UNASSIGNED]), hiddenSources: new Map([['sub:7', { name: '', color: null }]]) }, () => {
    assert(tagesIds() === '4', `Quelle UND Person: vom Unzugewiesenen bleibt nur, was nicht aus dem Abo kommt, war ${tagesIds()}`);
  });
});

// Codex-Befund auf PR #1124: ein neuer Termin fuer einen Google- oder
// CalDAV-Kalender traegt `calendar_ref_id` erst nach dem Hochladen. Der Server
// loest die Quelle deshalb ueber das Ziel auf (`source_calendar_ref_id`, siehe
// test-calendar-routes.js), und der Filter muss genau dieses Feld lesen.
test('#1064: ein Termin fuer einen ausgeblendeten Kalender fehlt schon vor dem Hochladen', () => {
  const { eventSourceKey, calendarSources } = calendarHelpers;
  const unterwegs = {
    id: 5, title: 'Neu im Arbeitskalender', start_datetime: `${FILTER_TAG}T12:00:00`, assigned_users: [{ id: 1 }],
    calendar_ref_id: null, source_calendar_ref_id: 5, cal_name: null, cal_color: null,
  };
  assert(eventSourceKey(unterwegs) === 'cal:5', 'die aufgeloeste Quelle zaehlt, auch ohne calendar_ref_id');
  const termine = [unterwegs, ...FILTER_TERMINE];
  const basis = { events: termine, users: NUTZER, assignedToMe: false, people: new Set(), layerBirthdays: true };
  mitFilterzustand({ ...basis, hiddenSources: new Map([['cal:5', { name: 'Arbeit', color: '#3366cc' }]]) }, () => {
    assert(tagesIds() === '1,3,4', `der neue Termin geht mit seinem Kalender, war ${tagesIds()}`);
  });
  mitFilterzustand({ ...basis, hiddenSources: new Map() }, () => {
    const arbeit = calendarSources().find((q) => q.key === 'cal:5');
    assert(arbeit.name === 'Arbeit' && arbeit.color === '#3366cc',
      `Name und Farbe kommen vom synchronisierten Termin derselben Quelle, auch wenn der neue zuerst steht, war ${JSON.stringify(arbeit)}`);
  });
  mitFilterzustand({ ...basis, events: [unterwegs], hiddenSources: new Map([['cal:5', { name: 'Arbeit', color: '#3366cc' }]]) }, () => {
    const arbeit = calendarSources().find((q) => q.key === 'cal:5');
    assert(arbeit.name === 'Arbeit', `steht nur der neue im Zeitraum, nennt der Merker den Kalender, war ${JSON.stringify(arbeit)}`);
  });
  // Codex-Review zu PR #1124: ohne Merker und ohne synchronisierten Nachbarn
  // stand der Kalender als namenloses „Kalender" im Blatt. Der Server liefert
  // Name und Farbe der aufgeloesten Quelle mit.
  const mitQuelle = { ...unterwegs, source_calendar_name: 'Arbeit', source_calendar_color: '#3366cc' };
  mitFilterzustand({ ...basis, events: [mitQuelle], hiddenSources: new Map() }, () => {
    const arbeit = calendarSources().find((q) => q.key === 'cal:5');
    assert(arbeit.name === 'Arbeit' && arbeit.color === '#3366cc',
      `ein neuer Termin allein nennt seinen Kalender, war ${JSON.stringify(arbeit)}`);
  });
});

test('#1064: das Blatt kennt jede Quelle aus den Terminen und jede ausgeblendete, auch ohne Termin', () => {
  const { calendarSources } = calendarHelpers;
  mitFilterzustand({ events: FILTER_TERMINE, hiddenSources: new Map([['cal:9', { name: 'Urlaub', color: '#aa5500' }]]) }, () => {
    const quellen = calendarSources();
    assert(quellen.map((q) => q.key).join(',') === 'sub:7,cal:5,cal:9',
      `nach Namen sortiert, die ausgeblendete ohne Termin dabei, war ${quellen.map((q) => q.key)}`);
    assert(quellen.find((q) => q.key === 'cal:5').color === '#3366cc', 'die Farbe kommt vom Termin');
    assert(quellen.find((q) => q.key === 'cal:9').name === 'Urlaub', 'der Name der ausgeblendeten aus dem Merker');
  });
});

test('#1064: beide Filter kommen gegen den Speicher geprueft zurueck', () => {
  const { restorePeopleFilter, restoreHiddenSources, UNASSIGNED } = calendarHelpers;
  mitSpeicher({ 'yuvomi:calendar:people': JSON.stringify([1, UNASSIGNED, 99]) }, () => {
    const set = restorePeopleFilter(NUTZER);
    assert(set.has(1) && set.has(UNASSIGNED) && !set.has(99) && set.size === 2,
      'der Eintrag ueberlebt das Laden, eine unbekannte ID nicht');
  });
  mitSpeicher({ 'yuvomi:calendar:people': JSON.stringify([1, 2, UNASSIGNED]) }, () => {
    assert(restorePeopleFilter(NUTZER).size === 0, 'alle Personen und der Eintrag heisst alle - also kein Filter');
  });
  mitSpeicher({ 'yuvomi:calendar:people': JSON.stringify([1]) }, () => {
    const set = restorePeopleFilter(NUTZER);
    assert(set.size === 1 && !set.has(UNASSIGNED), 'ein alter Filter bekommt den Eintrag nicht untergeschoben');
  });
  mitSpeicher({
    'yuvomi:calendar:sources-hidden:1': JSON.stringify([
      { key: 'sub:7', name: 'Abfallkalender', color: '#228844' },
      { key: 'cal:5', name: 'Arbeit', color: 'red;background:url(x)' },
      { key: 'fremd:1', name: 'x' },
      null,
    ]),
  }, () => {
    const quellen = restoreHiddenSources(1);
    assert(quellen.size === 2 && quellen.has('sub:7') && quellen.has('cal:5'), 'nur gueltige Schluessel');
    assert(quellen.get('cal:5').color === null, 'aus dem Speicher nur, was eine Farbe ist');
  });
  mitSpeicher({ 'yuvomi:calendar:sources-hidden:1': '{kaputt' }, () => {
    assert(restoreHiddenSources(1).size === 0, 'ein kaputter Eintrag ist kein Filter');
  });
});

// Codex-Review zu PR #1124: der Merker traegt Namen und Farben. Ein privates Abo
// sieht nur, wer es angelegt hat - auf einem geteilten Browser stand sein Name
// sonst im Filterblatt des naechsten Kontos.
test('#1064: die ausgeblendeten Quellen gehoeren dem Nutzer, nicht dem Geraet', () => {
  const { restoreHiddenSources, persistHiddenSources } = calendarHelpers;
  mitSpeicher({ 'yuvomi:calendar:sources-hidden:1': JSON.stringify([{ key: 'sub:7', name: 'Privat', color: null }]) }, () => {
    assert(restoreHiddenSources(1).get('sub:7')?.name === 'Privat', 'der eigene Merker kommt zurueck');
    assert(restoreHiddenSources(2).size === 0, 'ein anderes Konto auf demselben Geraet sieht ihn nicht');
    assert(restoreHiddenSources(null).size === 0, 'ohne angemeldeten Nutzer gibt es keinen');
  });
  mitSpeicher({ 'yuvomi:calendar:sources-hidden': JSON.stringify([{ key: 'sub:7', name: 'Alt', color: null }]) }, () => {
    assert(restoreHiddenSources(1).size === 0, 'ein geraeteweiter Eintrag gehoert niemandem');
  });
  mitSpeicher({}, (daten) => {
    mitFilterzustand({ user: { id: 3 }, hiddenSources: new Map([['sub:7', { name: 'Privat', color: null }]]) }, () => {
      persistHiddenSources();
    });
    assert([...daten.keys()].join(',') === 'yuvomi:calendar:sources-hidden:3', `geschrieben unter dem Nutzer, war ${[...daten.keys()]}`);
    mitFilterzustand({ user: null, hiddenSources: new Map([['cal:5', { name: 'Arbeit', color: null }]]) }, () => {
      persistHiddenSources();
    });
    assert(daten.size === 1, 'ohne Nutzer wird nichts geschrieben');
  });
  // Die Funktion kann stimmen und der Aufrufer trotzdem keine ID uebergeben -
  // dann kaeme nach jedem Laden ein leerer Filter heraus, und alles oben bliebe gruen.
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert(/state\.hiddenSources = restoreHiddenSources\(state\.user\?\.id\);/.test(src),
    'render() liest den Merker des angemeldeten Nutzers');
});

test('#1064: eine ausgeblendete Quelle zaehlt am Filterknopf als ein Filter', () => {
  const { activeFilterCount } = calendarHelpers;
  const basis = { assignedToMe: false, people: new Set(), holidayPrefs: {}, layerBirthdays: true, layerSchedule: true };
  // scheduleEnabled() fragt window.yuvomi - ohne Modul-Registry gilt der Schichtplan als an.
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    mitFilterzustand({ ...basis, hiddenSources: new Map() }, () => {
      assert(activeFilterCount() === 0, `ohne ausgeblendete Quelle kein Filter, war ${activeFilterCount()}`);
    });
    mitFilterzustand({ ...basis, hiddenSources: new Map([['cal:5', {}], ['sub:7', {}]]) }, () => {
      assert(activeFilterCount() === 1, `zwei ausgeblendete Quellen sind EINE Achse, war ${activeFilterCount()}`);
    });
  } finally {
    globalThis.window = previousWindow;
  }
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Calendar-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
