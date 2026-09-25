/**
 * Modul: Kalender-Test
 * Zweck: Validiert alle Calendar-API-Abfragen, Datumsbereichs-Filter,
 *        Constraints, CRUD-Logik
 * Ausführen: node --experimental-sqlite test-calendar.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { eachRule } from './css-rules.js';
const { __test: calendarHelpers } = await import('../public/pages/calendar.js');
const periodSwipe = await import('../public/utils/period-swipe.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

// Fake-Knopf mit einer echten (Set-gestuetzten) classList und einem
// `inert`-Feld - genug DOM-Oberflaeche, um `.is-current` und `inert` wie im
// echten Browser zu pruefen, ohne eine ganze DOM-Bibliothek zu laden.
function fakeResetButton() {
  const classes = new Set();
  return {
    inert: false,
    classList: {
      toggle(cls, force) { if (force) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
  };
}

// #1164: EIN Positions- und EINE Sichtbarkeitsregel fuer den Zeitraum-Reset.
// Verhaltensgetrieben: geprueft werden der GERENDERTE Kopf und die echte
// Sync-Funktion, nicht der Quelltext.
//
// PR #1200 Review, Blocking 1: `hidden` loeste in `display: none` auf und nahm
// die Box aus dem Fluss - `.cal-toolbar__label` (`flex: 1 1 auto`) wuchs dann
// in den frei gewordenen Platz und "›" ruckte um die Knopfbreite, sobald der
// Reset erschien/verschwand (gemessen 7/11 ueber 33 Layouts). Ersetzt durch
// `.is-current` (visibility, Box bleibt im Fluss) + `inert`
// (Zeiger/Fokus/A11y-Baum). Dieser Test pinnt jetzt GENAU DIESEN Mechanismus
// fest: eine Rueckkehr zu `hidden` faellt hier durch.
test('Zeitraum-Kopf: zurueck, Wert, vor - dahinter „Heute", per .is-current+inert verborgen im angezeigten Zeitraum (#1164, #1200)', () => {
  // (a) Reihenfolge im gerenderten Markup: der Reset steht HINTER dem Stepper.
  const ids = [...calendarHelpers.periodNavHtml().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert(JSON.stringify(ids) === JSON.stringify(['cal-prev', 'cal-label', 'cal-next', 'cal-today']),
    `erwartet zurueck, Wert, vor, Reset - gerendert: ${ids.join(', ')}`);

  // (b) Sichtbarkeit: im angezeigten Zeitraum traegt der Reset `.is-current`
  // und `inert`, behaelt aber sein Element (der Slot bleibt reserviert).
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = {
    querySelector: (sel) => (sel === '#cal-today' ? btn : sel === '#cal-prev' ? prevBtn : null),
    contains: () => false,
  };
  const zuvor = {
    view: calendarHelpers.state.view,
    cursor: calendarHelpers.state.cursor,
    today: calendarHelpers.state.today,
  };
  try {
    calendarHelpers.state.view = 'month';
    calendarHelpers.state.today = '2026-06-15';
    calendarHelpers.state.cursor = '2026-06-15';
    calendarHelpers.syncTodayButton(root);
    assert(btn.classList.contains('is-current') === true, 'im angezeigten Monat muss der Reset .is-current tragen');
    assert(btn.inert === true, 'im angezeigten Monat muss der Reset inert sein');
    calendarHelpers.state.cursor = '2026-08-15';
    calendarHelpers.syncTodayButton(root);
    assert(btn.classList.contains('is-current') === false, 'ausserhalb des angezeigten Monats darf der Reset nicht .is-current sein');
    assert(btn.inert === false, 'ausserhalb des angezeigten Monats darf der Reset nicht inert sein');
  } finally {
    Object.assign(calendarHelpers.state, zuvor);
  }
});

// PR #1200 Review, Should-fix 3 (Calendar "kostenlos mitgenommen"): war der
// Reset fokussiert, als goToday() ihn selbst inert macht, faellt der Fokus
// ohne Gegenmassnahme auf `<body>`.
test('syncTodayButton() rettet den Fokus vor dem eigenen inert-Werden', () => {
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = {
    querySelector: (sel) => (sel === '#cal-today' ? btn : sel === '#cal-prev' ? prevBtn : null),
    contains: (el) => el === btn || el === prevBtn,
  };
  const zuvor = {
    view: calendarHelpers.state.view,
    cursor: calendarHelpers.state.cursor,
    today: calendarHelpers.state.today,
  };
  const zuvorDocument = globalThis.document;
  try {
    globalThis.document = { activeElement: btn };
    calendarHelpers.state.view = 'month';
    calendarHelpers.state.today = '2026-06-15';
    calendarHelpers.state.cursor = '2026-08-15'; // erst NICHT aktuell
    calendarHelpers.syncTodayButton(root);
    assert(btn.inert === false);

    let fokussiert = false;
    prevBtn.focus = () => { fokussiert = true; globalThis.document.activeElement = prevBtn; };
    calendarHelpers.state.cursor = '2026-06-15'; // jetzt wird der fokussierte Knopf aktuell
    calendarHelpers.syncTodayButton(root);
    assert(fokussiert === true, 'der Fokus muss vor dem inert-Werden auf den Zurueck-Pfeil wandern');
    assert(btn.inert === true);
  } finally {
    Object.assign(calendarHelpers.state, zuvor);
    globalThis.document = zuvorDocument;
  }
});

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

// DAS RASTER HAT SO VIELE ZEILEN, WIE DER MONAT BRAUCHT (Critique 2026-09-24).
// Hier stand ein Test ueber eine TESTEIGENE addDays-Kopie ("42 Tage") - er
// pruefte die Arithmetik seiner selbst, nicht die Seite. Geprueft wird jetzt
// das echte Ladefenster: im September 2026 (Wochenstart Montag) war die
// sechste Zeile komplett Oktober und wurde trotzdem geladen und gezeichnet.
test('Monatsraster: vier bis sechs Wochenzeilen, und das Ladefenster endet mit der letzten', () => {
  const { getMonthRange, getRangeForView, state } = calendarHelpers;
  const cases = [
    // [Cursor, Wochenstart, from, to] - Sep 2026 beginnt Di, Feb 2027 Mo, Aug 2026 Sa
    ['2026-09-24', 1, '2026-08-31', '2026-10-04'], // 5 Zeilen, nicht 6
    ['2027-02-10', 1, '2027-02-01', '2027-02-28'], // 4 Zeilen: 28 Tage ab Montag
    ['2026-08-15', 1, '2026-07-27', '2026-09-06'], // 6 Zeilen bleiben 6
    ['2026-09-24', 0, '2026-08-30', '2026-10-03'], // Sonntag-Start: 5 Zeilen
  ];
  for (const [cursor, weekStart, from, to] of cases) {
    const r = getMonthRange(cursor, weekStart);
    assert(r.from === from && r.to === to,
      `${cursor} (Start ${weekStart}): erwartet ${from}..${to}, erhalten ${r.from}..${r.to}`);
  }
  // Der echte Aufrufer (Ladefenster der Ansicht) liest dieselbe Rechnung.
  const zuvor = state.weekStart;
  try {
    state.weekStart = 1;
    const v = getRangeForView('month', '2026-09-24');
    assert(v.to === '2026-10-04', `das Ladefenster des Monats laedt eine Zeile Oktober zu viel: ${v.to}`);
  } finally {
    state.weekStart = zuvor;
  }
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

// --------------------------------------------------------
// DIE ICON-REGEL (Critique 2026-09-24, P2): ein Termin zeigt vor seinem Titel
// in JEDER Ansicht dieselben Glyphen - sein Icon nur, wenn jemand eines gewaehlt
// hat (hasEventIcon), die Serienmarke bei jeder Serie. Vorher fragte nur das
// Tagesraster; Woche, Ganztag und Agenda setzten das Standardglyph als
// Fuellsel, der Monat gar keins.
//
// Gemessen am gerenderten Markup der FUENF Bausteine, nicht am Quelltext: ein
// Textguard zaehlte Aufrufe und sah nicht, welches Icon am Ende dasteht.
// --------------------------------------------------------
function glyphsBeforeTitle(html, title) {
  const at = html.indexOf(`>${title}<`);
  assert(at !== -1, `Vorbedingung: der Titel ${title} steht im Markup`);
  const head = html.slice(0, at);
  return {
    calendarGlyph: /data-lucide="calendar"/.test(head),
    ownIcon: /data-lucide="stethoscope"/.test(head),
    repeat: /class="calendar-repeat-icon"/.test(head),
  };
}

function everyEventView(ev) {
  const out = {};
  withMonthState({ events: [ev] }, () => {
    out.Monat = calendarHelpers.renderMonthDay('2026-09-24', true, { focusable: true });
    out.Woche = calendarHelpers.renderWeekEvent(ev, null, '2026-09-24');
    out.Tag = calendarHelpers.renderDayEvent(ev, null, '2026-09-24');
    out.Ganztag = calendarHelpers.renderAllDayEvent(ev, '2026-09-24');
    out.Agenda = calendarHelpers.renderAgendaEvent(ev, '2026-09-24');
  });
  return out;
}

const glyphEvent = (extra) => ({
  id: 5101, title: 'Zahnarzt', all_day: 0, assigned_users: [],
  start_datetime: '2026-09-24T09:00', end_datetime: '2026-09-24T10:30', ...extra,
});

test('Icon-Regel: das Standardglyph steht in KEINER Ansicht vor dem Titel', () => {
  for (const [view, html] of Object.entries(everyEventView(glyphEvent({ icon: 'calendar' })))) {
    assert(!glyphsBeforeTitle(html, 'Zahnarzt').calendarGlyph,
      `${view}: ein Termin ohne eigenes Icon traegt das Kalenderglyph als Fuellsel`);
  }
});

test('Icon-Regel: ein gewaehltes Icon steht in JEDER Ansicht vor dem Titel', () => {
  for (const [view, html] of Object.entries(everyEventView(glyphEvent({ icon: 'stethoscope' })))) {
    assert(glyphsBeforeTitle(html, 'Zahnarzt').ownIcon, `${view}: das gewaehlte Icon fehlt`);
  }
});

test('Icon-Regel: die Serienmarke steht in JEDER Ansicht vor dem Titel', () => {
  for (const [view, html] of Object.entries(everyEventView(glyphEvent({ recurrence_rule: 'FREQ=WEEKLY' })))) {
    assert(glyphsBeforeTitle(html, 'Zahnarzt').repeat, `${view}: die Serienmarke fehlt`);
  }
});

test('Icon-Regel: kein Baustein ruft das Icon an eventGlyphsHtml() vorbei', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const helper = src.slice(src.indexOf('function eventGlyphsHtml('), src.indexOf('function eventIconElement('));
  assert(/hasEventIcon\(ev\.icon\)/.test(helper) && /calendarRepeatIconHtml\(ev\)/.test(helper),
    'eventGlyphsHtml() muss hasEventIcon fragen und die Serienmarke setzen');
  for (const call of ['eventIconHtml(ev.icon', 'calendarRepeatIconHtml(ev)']) {
    const hits = src.split(call).length - 1;
    assert(hits === 1, `${call} steht ${hits}-mal im Quelltext - ausserhalb von eventGlyphsHtml() ist es eine zweite Icon-Regel`);
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
  // Das Datum EINMAL vorn, dann die Spanne im einen Zeitformat (timeSpanText).
  assert(text.startsWith('2026-09-10 calendar.dayRangeLabel'), `Datum, dann der Zeitraum über den Locale-Key: ${text}`);
  assert(whenRange(text).from === '2026-09-10T14:00', `Start ohne zweites Datum: ${text}`);
  assert(whenRange(text).to === '2026-09-10T15:30', `Ende ohne vorangestelltes Datum: ${text}`);
});

test('eventWhenText: das Uhrzeit-Suffix steht einmal, am Ende', () => {
  globalThis.__timeSuffix = 'Uhr';
  try {
    const one = eventWhenText({ start_datetime: '2026-09-10T14:00', end_datetime: '2026-09-10T15:30', all_day: 0 });
    const multi = eventWhenText({ start_datetime: '2026-09-10T14:00', end_datetime: '2026-09-12T11:00', all_day: 0 });
    for (const text of [one, multi]) {
      assert(text.split('Uhr').length === 2 && text.endsWith(' Uhr'),
        `„10:00 Uhr - 11:30 Uhr" war die alte Form, erwartet genau ein Suffix am Ende: ${text}`);
    }
  } finally {
    delete globalThis.__timeSuffix;
  }
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

// --------------------------------------------------------
// Der geteilte Monat am Telefon (Critique 2026-09-24, P2): Raster oben, der
// gewaehlte Tag als Liste darunter.
// --------------------------------------------------------

test('Monatszelle am Telefon: ein Tipp WAEHLT den Tag, statt in die Tagesansicht zu springen', () => {
  const { monthDayTapAction } = calendarHelpers;
  assert(monthDayTapAction('2026-09-10', '2026-09-24', { split: true }) === 'select',
    'ein Tag im selben Monat wird am Telefon gewaehlt');
  assert(monthDayTapAction('2026-10-02', '2026-09-24', { split: true }) === 'change-month',
    'ein Tag aus dem Nachbarmonat blaettert dorthin');
  assert(monthDayTapAction('2026-09-10', '2026-09-24', { split: false }) === 'open-day',
    'auf dem Desktop bleibt der Drill-in in den Tag');
});

// Die Entscheidung allein beweist nichts, wenn der Klick sie umgeht (Merker
// „Optionstest muss den Aufrufer lesen"). Vorher rief der Zellen-Handler
// switchToDayView() direkt - fuer jede Breite.
test('Monatszelle: Klick und Enter laufen ueber monthDayTapAction, nicht direkt in den Tag', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const render = src.slice(src.indexOf('function renderMonthView('), src.indexOf('async function activateMonthDay('));
  // Die Tastatur des Rasters wohnt seit dem ARIA-Grid (Schritt 3 der Critique
  // 2026-09-24) in wireMonthGridKeys - renderMonthView muss sie verdrahten.
  const keys = src.slice(src.indexOf('function wireMonthGridKeys('), src.indexOf('function focusFirstDayEntry('));
  assert(render.length > 0 && keys.length > 0, 'renderMonthView/wireMonthGridKeys nicht gefunden');
  assert(/wireMonthGridKeys\(grid/.test(render), 'renderMonthView verdrahtet die Rastertastatur nicht');
  const view = render + keys;
  assert(!/switchToDayView\(/.test(view),
    'renderMonthView ruft switchToDayView() direkt - der Tipp am Telefon wuerde wieder springen');
  assert((view.match(/activateMonthDay\(/g) ?? []).length >= 2,
    'Klick UND Enter/Space muessen ueber activateMonthDay() laufen');
  const act = src.slice(src.indexOf('async function activateMonthDay('));
  assert(/monthDayTapAction\(/.test(act.slice(0, act.indexOf('\n}\n'))),
    'activateMonthDay() entscheidet nicht ueber monthDayTapAction()');
});

test('Monatswechsel: gewaehlt ist heute, wenn der Monat heute enthaelt, sonst der Erste', () => {
  const { monthStepCursor } = calendarHelpers;
  const TODAY = '2026-09-24';
  assert(monthStepCursor('2026-08-12', 1, TODAY) === TODAY, 'in den laufenden Monat: heute');
  assert(monthStepCursor('2026-09-24', 1, TODAY) === '2026-10-01', 'in einen anderen Monat: der Erste');
  assert(monthStepCursor('2026-01-31', 1, TODAY) === '2026-02-01',
    'vom 31. aus nicht per setMonth() in den Maerz rechnen');
  assert(monthStepCursor('2026-03-31', -1, TODAY) === '2026-02-01', 'rueckwaerts genauso');
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const nav = src.slice(src.indexOf('async function navigate('), src.indexOf('async function goToday('));
  assert(/monthStepCursor\(/.test(nav), 'navigate() blaettert den Monat nicht ueber monthStepCursor()');
});

// EINGEKLAPPT GEHT DER TELEFON-MONAT WOCHENWEISE (Critique 2026-09-24, Rest 1).
// Vorher sprang Wischen/Pfeil auch eingeklappt einen Monat, und die Auswahl
// riss vom 24.09. auf den 01.10. - weg aus der einen Woche, die man sah.
test('Schrittweite: eingeklappter Telefon-Monat geht eine Woche, sonst gilt die Ansicht', () => {
  const { periodStepOf: step } = calendarHelpers;
  assert(step('month', { mobile: true, monthCollapsed: true }).unit === 'week', 'eingeklappt: Woche');
  assert(step('month', { mobile: true, monthCollapsed: true }).days === 7, 'eingeklappt: sieben Tage');
  assert(step('month', { mobile: true, monthCollapsed: false }).unit === 'month', 'aufgeklappt: Monat');
  assert(step('month', { mobile: false, monthCollapsed: true }).unit === 'month',
    'auf dem Desktop gibt es kein Einklappen - ein liegengebliebener Zustand nach dem Drehen zaehlt nicht');
  assert(step('week', { mobile: true }).days === 3 && step('week', { mobile: false }).days === 7, 'Woche: 3 Tage mobil, 7 sonst');
  assert(step('day').days === 1 && step('agenda').days === 30, 'Tag 1, Agenda 30');

  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const nav = src.slice(src.indexOf('async function navigate('), src.indexOf('async function goToday('));
  assert(/currentPeriodStep\(\)/.test(nav), 'navigate() liest die Schrittweite nicht aus currentPeriodStep()');
  assert(!/dir \* 30|dir \* \(isMobile/.test(nav), 'navigate() rechnet eine eigene Schrittweite neben periodStepOf()');
  const cur = src.slice(src.indexOf('function currentPeriodStep('), src.indexOf('function periodArrowLabels('));
  assert(/monthCollapsed:\s*_monthCollapsed/.test(cur), 'currentPeriodStep() fragt den Einklapp-Zustand nicht');
  const sync = src.slice(src.indexOf('function syncMonthCollapse('), src.indexOf('function syncMonthCollapse(') + 400);
  assert(/syncPeriodArrows\(\)/.test(sync), 'Einklappen benennt die Pfeile nicht um - sie hiessen weiter „Monat"');
});

// DIE PFEILE SAGEN, WAS SIE TUN (Critique 2026-09-24, Rest 8): in jeder
// Ansicht hiessen sie „Zurueck"/„Weiter", und in der Agenda sprang „Weiter"
// dreissig Tage, ohne dass es irgendwo stand.
test('Pfeilnamen folgen der Schrittweite, die Agenda nennt ihre Spanne', () => {
  const { periodArrowLabels: labels, periodStepOf: step } = calendarHelpers;
  assert(labels(step('month')).next === 'calendar.nextMonth', 'Monat');
  assert(labels(step('month', { mobile: true, monthCollapsed: true })).prev === 'calendar.prevWeek', 'eingeklappter Monat: Woche');
  assert(labels(step('week')).next === 'calendar.nextWeek', 'Woche am Desktop');
  assert(labels(step('week', { mobile: true })).next === 'calendar.nextDays{"count":3}', 'Drei-Tage-Fenster am Telefon');
  assert(labels(step('day')).prev === 'calendar.prevDay', 'Tag');
  assert(labels(step('agenda')).next === 'calendar.nextDays{"count":30}', 'Agenda: dreissig Tage');

  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const nav = src.slice(src.indexOf('function periodNavHtml('), src.indexOf('const CAL_SHORTCUT_KEYS'));
  assert(!/calendar\.(back|forward)/.test(nav), 'die Pfeile tragen wieder das allgemeine Zurueck/Weiter');
  const upd = src.slice(src.indexOf('function updateLabel('), src.indexOf('function updateLabel(') + 2200);
  assert(/syncPeriodArrows\(\)/.test(upd), 'updateLabel() benennt die Pfeile nach einem Ansichtswechsel nicht um');
  assert(!/agendaFrom/.test(src), 'die Agenda nennt wieder nur ihren Anfang („Ab ...")');
  assert(/view === 'agenda'\)[\s\S]{0,200}getAgendaRange\(state\.cursor\)[\s\S]{0,200}dayRangeLabel/.test(upd),
    'das Agenda-Label nennt nicht die Spanne, die getAgendaRange() laedt');
});

// DIE TITELFASSUNG LAESST DER TAGESLISTE PLATZ (Critique 2026-09-24, Rest 2):
// mit 80px je Woche blieben der Liste bei 375x812 genau 81px, im Sechs-
// Wochen-Monat nichts. Die Wochen teilen sich jetzt ein festes Budget.
test('Titelfassung am Telefon: die Wochen teilen sich 320px, keine Zeile unter 48px', () => {
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const px = (name) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(tokens)?.[1]);
  const rule = [...eachRule(calendarCss)].find((r) => r.at.some((a) => /max-width:\s*639px/.test(a))
    && r.selector.trim() === '.month-view--split.month-view--titles .month-day');
  assert(rule, 'Zeilenregel der Titelfassung im geteilten Monat nicht gefunden');
  const decl = /--month-row-h:\s*([^;]+);/.exec(rule.body)?.[1];
  assert(decl && /var\(--month-weeks/.test(decl), 'die Zeilenhoehe haengt nicht an der Wochenzahl');
  const rowFor = (weeks) => Function(`return ${decl
    .replace(/var\(--month-weeks(?:,\s*\d+)?\)/g, String(weeks))
    .replace(/var\(--([\w-]+)\)/g, (_, n) => String(px(n)))
    .replace(/\bmin\(/g, 'Math.min(').replace(/\bcalc\(/g, '(')}`)();
  for (const weeks of [4, 5, 6]) {
    const row = rowFor(weeks);
    assert(row * weeks <= 320 + 0.5, `${weeks} Wochen belegen ${row * weeks}px - die Liste darunter schrumpft wieder`);
    assert(row >= 48, `${weeks} Wochen: ${row}px je Zeile - unter der Zielgroesse am Finger`);
  }
  assert(rowFor(4) === 80, 'vier Wochen behalten ihre drei Titelzeilen (80px)');
  const fit = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const body = fit.slice(fit.indexOf('function fitMonthDayCells('), fit.indexOf('function scheduleMonthFit('));
  assert(/closest\('\.month-view--split'\)/.test(body) && (body.match(/calendar\.moreEvents/g) ?? []).length === 1
    && /moreText\(total\)/.test(body) && /moreText\(hiddenCount\)/.test(body),
    'die Zelle im Telefon-Monat schreibt wieder „+N weitere" - bei ~50px Breite bricht das um und wird abgeschnitten');
});

// EINE KANTE FUER DEN TAG (Critique 2026-09-24, Konsistenz): Datum und
// Terminkarte standen bei x=12, Aufgaben- und Feiertags-Chips mit eigenem
// 12px-Einzug bei x=24 - eine dritte Fluchtlinie, weder Karte noch Text.
test('Agenda und Tagesliste: Aufgaben und Feiertage ruecken nicht ein', () => {
  const rules = [...eachRule(calendarCss)].filter((r) => r.at.length === 0);
  for (const sel of ['.agenda-tasks', '.agenda-holidays']) {
    const rule = rules.find((r) => r.selector.trim() === sel);
    assert(rule, `${sel} fehlt`);
    const pad = /(?:^|[;\s{])padding:\s*([^;]+);/.exec(rule.body)?.[1]?.trim().split(/\s+/);
    assert(pad && pad.length === 2 && pad[1] === '0', `${sel} rueckt mit ${pad?.[1]} ein - die Chips stehen nicht an der Kante von Datum und Karte`);
  }
});

// DAS AUFHEBEN LIEGT OHNE SCROLLEN IM BLICK (Critique 2026-09-24, Rest 4).
test('Filterblatt: „Alle Filter aufheben" steht in der Fusszeile des Blatts', () => {
  let opened = null;
  const prevOpen = globalThis.__openModal;
  const prevDoc = globalThis.document;
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.__openModal = (opts) => { opened = opts; };
  globalThis.document = { ...(prevDoc ?? {}), querySelector: () => null };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    calendarHelpers.openCalendarFilters();
  } finally {
    globalThis.__openModal = prevOpen;
    globalThis.document = prevDoc;
    if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window;
  }
  assert(opened, 'das Filterblatt oeffnet kein Modal');
  const footer = /<div class="modal-panel__footer">([\s\S]*?)<\/div>/.exec(opened.content);
  assert(footer && /id="cal-filters-reset"/.test(footer[1]),
    'der Aufheben-Knopf steht nicht in .modal-panel__footer - mountFooter() hebt ihn nicht an den Rand, er liegt unter der Falz');
  assert((opened.content.match(/id="cal-filters-reset"/g) ?? []).length === 1, 'der Knopf steht doppelt');
});

test('Einklappen auf die Woche: nur nach unten, nur mit Platz, auf am Listenanfang', () => {
  const { monthCollapseStep: step } = calendarHelpers;
  assert(step({ collapsed: false, top: 40, lastTop: 20, room: 200, hold: false }) === 'collapse',
    'nach unten gescrollt, und die Liste kann danach weiter scrollen');
  assert(step({ collapsed: false, top: 40, lastTop: 20, room: 4, hold: false }) === 'stay',
    'ohne Platz nach dem Einklappen klemmte scrollTop auf 0 und das Raster pumpte auf und zu');
  assert(step({ collapsed: false, top: 20, lastTop: 40, room: 200, hold: false }) === 'stay',
    'nach oben scrollen klappt nicht ein');
  assert(step({ collapsed: true, top: 0, lastTop: 30, room: 0, hold: false }) === 'expand',
    'zurueck am Listenanfang klappt auf');
  assert(step({ collapsed: true, top: 0, lastTop: 0, room: 0, hold: false }) === 'stay',
    'ohne Bewegung (per Knopf eingeklappt, Liste oben) bleibt es zu');
  assert(step({ collapsed: false, top: 80, lastTop: 60, room: 200, hold: true }) === 'stay',
    'nach ausdruecklichem Aufklappen nimmt der naechste Wisch die Entscheidung nicht zurueck');
  assert(step({ collapsed: false, top: 0, lastTop: 10, room: 200, hold: true }) === 'release',
    'erst der Weg ueber den Listenanfang gibt das Einklappen wieder frei');
});

// AUFGABE UND TERMIN UNTERSCHEIDET DIE FORM. Vorher war der einzige Unterschied
// ein Ring in --color-surface-work - der Farbe der Flaeche, auf der er steht,
// im Dark unsichtbar (calendar.css ~1931).
test('Punktfassung: Aufgabe ist ein abgerundetes Quadrat, Termin rund, beide im Tertiaer-Ring', () => {
  const inPhone = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  const rules = [...eachRule(calendarCss)].filter(inPhone);
  const task = rules.filter((r) => r.selector.includes(':not(.month-view--titles) .cal-task-chip')
    && !r.selector.includes(','));
  const own = task.find((r) => /border-radius/.test(r.body));
  assert(own, 'der Aufgabenpunkt hat keine eigene Form - er erbt den Kreis des Terminpunkts');
  assert(!/radius-full/.test(own.body), 'der Aufgabenpunkt ist rund und damit vom Termin nicht zu unterscheiden');
  for (const r of task) {
    assert(!/--color-surface-work/.test(r.body),
      `${r.selector.trim()}: ein Ring in der Flaechenfarbe ist im Dark unsichtbar`);
  }
  assert(task.some((r) => /box-shadow:[^;]*--color-text-tertiary/.test(r.body)),
    'der Aufgabenpunkt braucht die Tertiaer-Fassung der Ring-Regel (3:1)');
  const ev = rules.find((r) => r.selector.trim() === '.month-view:not(.month-view--titles) .month-day__event');
  assert(ev && /--color-text-tertiary/.test(ev.body), 'der Terminpunkt verliert seinen Ring');
});

test('Der Titel-Schalter wohnt am Monat, nicht mehr im Filterblatt', () => {
  const html = calendarHelpers.monthListHtml();
  assert(/id="month-titles-toggle"[^>]*aria-pressed="(true|false)"/.test(html),
    'der Listenkopf traegt keinen Titel-Schalter mit aria-pressed');
  assert(/id="month-collapse"[^>]*aria-controls="month-grid"/.test(html),
    'der Einklapp-Knopf fehlt oder nennt das Raster nicht');
  assert(/id="month-open-day"/.test(html), 'der Weg in die Tagesansicht fehlt im Listenkopf');
  assert(/class="[^"]*page-scrollport[^"]*" id="month-list-rows"/.test(html),
    'die Liste ist nicht der Scrollport - das Raster wuerde wieder scrollen');
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert(!/data-filter-month-titles/.test(src), 'das Filterblatt fuehrt den Titel-Schalter noch');
});

test('Telefon-Monat: „+" legt fuer den gewaehlten Tag an, der Reset fuehrt zu heute zurueck', () => {
  const { state, newEventDate, syncTodayButton } = calendarHelpers;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const zuvor = { view: state.view, cursor: state.cursor, today: state.today };
  try {
    Object.assign(state, { view: 'month', cursor: '2026-09-10', today: '2026-09-24' });
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    assert(newEventDate() === '2026-09-10', `am Telefon muss der gewaehlte Tag kommen, war ${newEventDate()}`);
    const btn = fakeResetButton();
    syncTodayButton({ querySelector: (sel) => (sel === '#cal-today' ? btn : null) });
    assert(btn.classList.contains('is-current') === false,
      'ein anderer Tag ist gewaehlt - „Heute" muss erreichbar sein');
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    assert(newEventDate() === '2026-09-24', 'auf dem Desktop gilt weiter die Zeitraumregel (#737)');
  } finally {
    Object.assign(state, zuvor);
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
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

// --------------------------------------------------------
// Kurze Termine ueber Mitternacht (#1313, aus Diskussion #1081)
//
// isAllDayLike() fragte ueber isMultiDayEvent() nur nach VERSCHIEDENEN
// Kalendertagen. Ein Termin 22:00-01:30 beruehrt zwei Tage und wurde dadurch
// als Chip ohne Uhrzeit in die Ganztags-Zeile BEIDER Tage gelegt -
// dreieinhalb Abendstunden sahen aus wie zwei ganze Tage, und die 90 Minuten
// nach Mitternacht standen nirgends da, wo jemand sie sucht.
//
// Die Laenge entscheidet jetzt mit: unter 24 Stunden geht der Termin ins
// Zeitraster beider Tage, an der Tagesgrenze geklammert (Tag 1 ab Startzeit
// bis Mitternacht, Tag 2 ab Mitternacht bis Endzeit) - dieselbe Arithmetik,
// die scheduleBlockTimeRange() fuer eine Nachtschicht laengst faehrt. Ab
// 24 Stunden bleibt der Termin bewusst in der Ganztags-Zeile, und die Agenda
// gibt unveraendert start/middle/end aus.
//
// Gemessen wird in der ANZEIGEZONE (localDate/localTime), nicht im UTC-Tag:
// der Fall mit zwei Instants weiter unten hat EINEN UTC-Tag und ZWEI lokale
// Tage. Eine Umsetzung ueber toISOString().slice(0, 10) faellt genau dort
// durch - deshalb nagelt "test:calendar" die Zone auf Europe/Berlin fest.
// --------------------------------------------------------

// Die Anzeigezone gehoert an den TEST, nicht an den Prozess (PR #1323,
// Befund 2). `setDisplayTimeZone()` ist der Weg, den ein Haushalt wirklich
// geht - dieselbe API, die die Seite selbst befragt, und ueber DENSELBEN
// Spezifizierer importiert wie calendar.js: ueber den Repo-Pfad waere es eine
// zweite Modulinstanz mit eigenem Zonen-Cache, und der Test liefe an seinem
// Gegenstand vorbei (Hausmuster: test-meals.js, test-dashboard.js).
//
// Vorher nagelte das npm-Skript `TZ=Europe/Berlin` fuer die GANZE Suite fest.
// Der Pin trug den einen Fall, der ihn braucht, deckte aber jede kuenftige
// Zonenabhaengigkeit der uebrigen Tests dieser Datei mit zu.
const { setDisplayTimeZone, displayTimeZone } = await import('/utils/timezone.js');

function withDisplayTimeZone(zone, fn) {
  const zuvor = displayTimeZone();
  try { setDisplayTimeZone(zone); fn(); }
  finally { setDisplayTimeZone(zuvor); }
}

const shortOvernight = { start_datetime: '2026-06-14T22:00', end_datetime: '2026-06-15T01:30', all_day: 0 };

test('isAllDayLike: 22:00 bis 01:30 am Folgetag bleibt im Zeitraster (#1313)', () => {
  assert(isAllDayLike(shortOvernight) === false,
    'dreieinhalb Stunden ueber Mitternacht sind kein Ganztags-Balken ueber zwei Tage');
});

test('isAllDayLike: 14:00 bis 11:00 zwei Tage spaeter (45 h) bleibt in der Ganztags-Zeile (#1313)', () => {
  const ev = { start_datetime: '2026-06-14T14:00', end_datetime: '2026-06-16T11:00', all_day: 0 };
  assert(isAllDayLike(ev) === true,
    'ab 24 Stunden bleibt der durchgehende Balken - die Entscheidung aus dem Faden, festgenagelt');
});

test('isAllDayLike: die 24-Stunden-Grenze von unten und von oben (#1313)', () => {
  const knappDrunter = { start_datetime: '2026-06-14T23:30', end_datetime: '2026-06-15T23:29', all_day: 0 };
  const genau        = { start_datetime: '2026-06-14T23:30', end_datetime: '2026-06-15T23:30', all_day: 0 };
  assert(isAllDayLike(knappDrunter) === false, '23 h 59 min gehoeren ins Zeitraster');
  assert(isAllDayLike(genau) === true, 'exakt 24 h gehoeren in die Ganztags-Zeile');
});

test('isAllDayLike: die Grenze ist WANDUHRZEIT, auch in der Nacht der Zeitumstellung (#1313)', () => {
  // Nacht auf den 29.03.2026, Europe/Berlin: um 02:00 springt die Uhr auf
  // 03:00, die Nacht hat 23 echte Stunden. Das Raster zeigt trotzdem 24
  // Sprossen, und die Termine stehen an ihrer Wanduhrzeit - also entscheidet
  // die Wanduhr, nicht die verstrichene Zeit.
  const nacht = { start_datetime: '2026-03-28T22:00', end_datetime: '2026-03-29T01:30', all_day: 0 };
  const rundeUm = { start_datetime: '2026-03-28T23:30', end_datetime: '2026-03-29T23:30', all_day: 0 };
  assert(isAllDayLike(nacht) === false, 'dreieinhalb Stunden bleiben dreieinhalb Stunden');
  assert(isAllDayLike(rundeUm) === true,
    '23:30 bis 23:30 sind auf der Wanduhr 24 Stunden, auch wenn nur 23 vergangen sind');
});

test('isAllDayLike: 22:00 bis exakt 00:00 bleibt eintaegig (#804 regressiert nicht)', () => {
  const ev = { start_datetime: '2026-06-14T22:00', end_datetime: '2026-06-15T00:00', all_day: 0 };
  assert(calendarHelpers.eventEndDate(ev) === '2026-06-14', 'eventEndDate() zieht das Ende einen Tag zurueck');
  assert(isMultiDayEvent(ev) === false, 'damit ist der Termin eintaegig');
  assert(isAllDayLike(ev) === false, 'und bleibt im Zeitraster');
});

test('isAllDayLike: ein Nacht-Termin mit EINEM UTC-Tag und ZWEI Anzeigetagen (#1313)', () => {
  // Haushalt auf Europe/Berlin, im Sommer (+02:00): 2026-06-14T20:00Z ist dort
  // der 14. um 22:00, 2026-06-14T23:30Z der 15. um 01:30. Beide Zeitpunkte
  // liegen im UTC-Tag 2026-06-14 - wer den Tag aus toISOString().slice(0, 10)
  // nimmt, sieht hier EINEN Tag und stellt die Laengenfrage nie.
  //
  // Die Zone steht am Test, nicht an der Prozessumgebung: so faellt dieser Fall
  // durch, egal wo der Testlaeufer steht.
  withDisplayTimeZone('Europe/Berlin', () => {
    const ev = { start_datetime: '2026-06-14T20:00:00Z', end_datetime: '2026-06-14T23:30:00Z', all_day: 0 };
    assert(new Date(ev.start_datetime).toISOString().slice(0, 10) === new Date(ev.end_datetime).toISOString().slice(0, 10),
      'Vorbedingung dieses Falls: beide Zeitpunkte liegen im selben UTC-Tag');
    assert(isMultiDayEvent(ev) === true, 'in der Anzeigezone sind es zwei Kalendertage');
    assert(isAllDayLike(ev) === false, 'und trotzdem nur dreieinhalb Stunden - also Zeitraster');
  });
});

test('die Tagesgrenze folgt der ANZEIGEZONE und verschiebt sich mit ihr (PR #1323, Befund 2)', () => {
  // Eine feste Zone allein belegt nichts: ohne einen Fall, in dem der Tag mit
  // der Zone WANDERT, waere die Suite in einer Zone gruen und wuerde den Fehler
  // in jeder anderen verstecken. Dieselben zwei Zeitpunkte, drei Haushalte:
  //   Europe/Berlin (+02:00): 14. 22:00 bis 15. 01:30 - ZWEI Kalendertage
  //   UTC:                    14. 20:00 bis 14. 23:30 - EIN Kalendertag
  //   Pacific/Kiritimati (+14:00): 15. 10:00 bis 15. 13:30 - EIN Kalendertag,
  //                           und zwar ein anderer als in UTC
  const ev = { start_datetime: '2026-06-14T20:00:00Z', end_datetime: '2026-06-14T23:30:00Z', all_day: 0 };
  const { eventEndDate } = calendarHelpers;

  withDisplayTimeZone('Europe/Berlin', () => {
    assert(eventEndDate(ev) === '2026-06-15', `Berlin: Endtag der 15., erhalten ${eventEndDate(ev)}`);
    assert(isMultiDayEvent(ev) === true, 'Berlin: zwei Kalendertage');
    assert(isAllDayLike(ev) === false, 'Berlin: dreieinhalb Stunden gehoeren ins Zeitraster');
    assert(agendaSegmentKind(ev, '2026-06-15') === 'end', 'Berlin: der 15. ist der Endtag');
  });

  withDisplayTimeZone('UTC', () => {
    assert(eventEndDate(ev) === '2026-06-14', `UTC: Endtag der 14., erhalten ${eventEndDate(ev)}`);
    assert(isMultiDayEvent(ev) === false, 'UTC: EIN Kalendertag - die Tagesgrenze ist mitgewandert');
    assert(agendaSegmentKind(ev, '2026-06-14') === 'single', 'UTC: ein gewoehnlicher Termin des 14.');
  });

  withDisplayTimeZone('Pacific/Kiritimati', () => {
    assert(eventEndDate(ev) === '2026-06-15', `Kiritimati: Endtag der 15., erhalten ${eventEndDate(ev)}`);
    assert(isMultiDayEvent(ev) === false, 'Kiritimati: EIN Kalendertag, naemlich der 15.');
    assert(agendaSegmentKind(ev, '2026-06-15') === 'single', 'Kiritimati: ein gewoehnlicher Termin des 15.');
  });
});

test('agendaSegmentKind: der kurze Nacht-Termin gibt unveraendert start/end aus (#1313)', () => {
  assert(agendaSegmentKind(shortOvernight, '2026-06-14') === 'start', 'Tag 1 bleibt start');
  assert(agendaSegmentKind(shortOvernight, '2026-06-15') === 'end',   'Tag 2 bleibt end');
});

// --------------------------------------------------------
// ... und dasselbe ueber die echten Ansichts-Aufrufer. Ein Unit-Test auf dem
// Praedikat allein bliebe gruen, waehrend nichts es anders aufruft: erst
// renderWeekView()/renderDayView() zeigen, ob der Termin wirklich im Raster
// landet und ob seine Spanne am Tagesrand geklammert wird.
// --------------------------------------------------------

function overnightEvent() {
  return {
    id: 4131, title: 'Sommerfest', all_day: 0, assigned_users: [],
    start_datetime: '2026-06-14T22:00', end_datetime: '2026-06-15T01:30',
  };
}

function morningEvent() {
  return {
    id: 4132, title: 'Fruehstueck', all_day: 0, assigned_users: [],
    start_datetime: '2026-06-15T09:00', end_datetime: '2026-06-15T10:00',
  };
}

// Wochenstart Sonntag, damit Sonntag der 14. und Montag der 15. in DERSELBEN
// gerenderten Woche liegen - sonst waere der Starttag gar nicht im Bild.
function withOvernightState(extra, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const previousState = { ...calendarHelpers.state };
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    Object.assign(calendarHelpers.state, {
      cursor: '2026-06-15',
      today: '2026-06-15',
      weekStart: 0,
      scheduleDisplay: 'compact',
      layerSchedule: false,
      layerBirthdays: true,
      layerHolidays: false,
      layerSchool: false,
      layerWaste: false,
      assignedToMe: false,
      people: new Set(),
      hiddenSources: new Set(),
      events: [],
      tasks: [],
      holidays: [],
      users: [],
      scheduleEntries: [],
      ...extra,
    });
    fn();
  } finally {
    Object.assign(calendarHelpers.state, previousState);
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
}

// Der Abschnitt einer Wochenspalte, von ihrem data-date bis zur naechsten.
function weekColumnHtml(html, dayStr) {
  const marker = `class="week-view__col" data-date="${dayStr}"`;
  const from = html.indexOf(marker);
  if (from === -1) return '';
  const next = html.indexOf('class="week-view__col" data-date="', from + marker.length);
  return html.slice(from, next === -1 ? undefined : next);
}

const TIMED_BLOCK_RE = /class="(week|day)-event[^"]*" data-id="(\d+)"\s+style="top:([^;]+);height:([^;]+);left:([^;]+);width:([^;"]+);/g;

function timedBlocks(html) {
  return [...html.matchAll(TIMED_BLOCK_RE)].map((m) => ({
    id: Number(m[2]), top: m[3], height: m[4], width: m[6],
  }));
}

const { hourOffset } = calendarHelpers;

test('renderWeekView: der kurze Nacht-Termin steht als Zeitblock in BEIDEN Spalten und in keiner Ganztags-Zelle (#1313)', () => {
  withOvernightState({ events: [overnightEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    const html = container.html;

    const alldayRow = html.slice(0, html.indexOf('week-view__scroll'));
    assert(!alldayRow.includes('class="allday-event"'),
      'der Termin darf in keiner Ganztags-Zelle mehr stehen - genau das war der gemeldete Fehler');

    const tagEins = timedBlocks(weekColumnHtml(html, '2026-06-14'));
    const tagZwei = timedBlocks(weekColumnHtml(html, '2026-06-15'));
    assert(tagEins.length === 1 && tagEins[0].id === 4131,
      `der 14. muss genau einen Zeitblock zeigen: ${JSON.stringify(tagEins)}`);
    assert(tagZwei.length === 1 && tagZwei[0].id === 4131,
      `der 15. muss genau einen Zeitblock zeigen: ${JSON.stringify(tagZwei)}`);

    assert(tagEins[0].top === hourOffset(22 * 60), `Tag 1 beginnt um 22:00: ${tagEins[0].top}`);
    assert(tagEins[0].height === `calc(${hourOffset(2 * 60)} - 2px)`,
      `Tag 1 laeuft zwei Stunden bis Mitternacht, nicht weiter und nicht kuerzer: ${tagEins[0].height}`);
    assert(tagZwei[0].top === hourOffset(0), `Tag 2 beginnt um Mitternacht: ${tagZwei[0].top}`);
    assert(tagZwei[0].height === `calc(${hourOffset(90)} - 2px)`,
      `Tag 2 laeuft 90 Minuten bis 01:30: ${tagZwei[0].height}`);
  });
});

test('renderDayView: am Starttag laeuft der Nacht-Termin von 22:00 bis Mitternacht (#1313)', () => {
  withOvernightState({ cursor: '2026-06-14', events: [overnightEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const html = container.html;
    assert(!html.includes('class="allday-event"'), 'kein Ganztags-Chip mehr in der Tagesansicht');
    const bloecke = timedBlocks(html);
    assert(bloecke.length === 1 && bloecke[0].id === 4131,
      `die Tagesansicht muss den Termin als Zeitblock zeigen: ${JSON.stringify(bloecke)}`);
    assert(bloecke[0].top === hourOffset(22 * 60), `Beginn 22:00: ${bloecke[0].top}`);
    assert(bloecke[0].height === `calc(${hourOffset(2 * 60)} - 4px)`,
      `Ende an der Tagesgrenze, also zwei Stunden hoch: ${bloecke[0].height}`);
  });
});

test('renderDayView: am zweiten Tag endet der Nacht-Termin um 01:30 (#1313)', () => {
  withOvernightState({ cursor: '2026-06-15', events: [overnightEvent(), morningEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const bloecke = timedBlocks(container.html);
    assert(bloecke.length === 2, `beide Termine gehoeren ins Raster: ${JSON.stringify(bloecke)}`);
    const nacht = bloecke.find((b) => b.id === 4131);
    const morgen = bloecke.find((b) => b.id === 4132);
    assert(nacht && morgen, 'Nacht-Termin und Fruehstueck muessen beide gerendert sein');
    assert(nacht.top === hourOffset(0), `der Nacht-Termin beginnt um Mitternacht: ${nacht.top}`);
    assert(nacht.height === `calc(${hourOffset(90)} - 4px)`,
      `er endet um 01:30, nicht irgendwo im Abend: ${nacht.height}`);
  });
});

// Eigener Test statt fuenfte Zusicherung im vorigen (PR #1323): dort warf die
// Hoehen-Zusicherung darueber immer zuerst, die Spaltenkosten kamen nie an die
// Reihe. Was nicht rot werden kann, belegt nichts.
test('renderDayView: der Nacht-Block kostet den Vormittag keine Spalte (#1313)', () => {
  withOvernightState({ cursor: '2026-06-15', events: [overnightEvent(), morningEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const bloecke = timedBlocks(container.html);
    const nacht = bloecke.find((b) => b.id === 4131);
    const morgen = bloecke.find((b) => b.id === 4132);
    assert(nacht && morgen, `Vorbedingung: beide Termine muessen gerendert sein: ${JSON.stringify(bloecke)}`);
    // Die Spaltenkosten sind das ganze Argument der Entscheidung: weil der
    // Block um Mitternacht endet, ueberlappt er den Vormittag nicht - beide
    // Termine behalten die volle Breite (totalCols === 1).
    assert(nacht.width === 'calc(100% - 14px)' && morgen.width === 'calc(100% - 14px)',
      `der Nacht-Block darf die Ueberlappungs-Gruppe des Vormittags nicht aufziehen: ${nacht.width} / ${morgen.width}`);
  });
});

// Zwei Vorkommen DERSELBEN Serie treffen sich an einem Tag. Vor #1313 konnte das
// nicht passieren: jeder Termin ueber Mitternacht ging in die Ganztags-Zeile und
// erreichte layoutOverlaps() nie. Seit der Fix nur noch Termine ab 24 h dort
// laesst, kommt eine TAEGLICHE Nachtschicht ins Raster - und dann liegen am
// 15. zwei Vorkommen: der geklammerte Schwanz vom 14. (00:00-01:30) und der Kopf
// vom 15. (22:00-24:00).
//
// `expandRecurringEvents()` gibt keinem Vorkommen eine eigene id
// (server/services/calendar-events.js: `{ ...event, start_datetime, end_datetime }`,
// kein id-Ueberschreiben), also tragen beide die id der Serie. Mit `ev.id` als
// Schluessel schreibt der zweite Platz den ersten still tot.
//
// Der Schichtplan drei Funktionen weiter hatte dieses Problem schon und hat es
// anders geloest: `layoutScheduleBlocks()` nimmt das Eintrags-OBJEKT als
// Schluessel (#1043, Muster + Extra-Schicht). Genau das gilt jetzt auch hier.
test('layoutOverlaps: zwei Vorkommen derselben Serie an einem Tag bekommen eigene Plaetze (#1323)', () => {
  const nachtschicht = (start, end) => ({
    id: 4200, title: 'Nachtschicht', all_day: 0, assigned_users: [],
    start_datetime: start, end_datetime: end,
  });
  const schwanz = nachtschicht('2026-06-14T22:00', '2026-06-15T01:30');
  const kopf    = nachtschicht('2026-06-15T22:00', '2026-06-16T01:30');
  const anruf = {
    id: 4201, title: 'Anruf', all_day: 0, assigned_users: [],
    start_datetime: '2026-06-15T01:00', end_datetime: '2026-06-15T02:00',
  };

  const layout = calendarHelpers.layoutOverlaps([schwanz, anruf, kopf], '2026-06-15');

  assert(layout.size === 3,
    'drei sichtbare Bloecke brauchen drei Plaetze - mit der Serien-id als Schluessel '
    + `tragen Schwanz und Kopf denselben, und der spaetere gewinnt: ${layout.size}`);

  assert(layout.get(schwanz)?.totalCols === 2 && layout.get(anruf)?.totalCols === 2,
    'der Schwanz (00:00-01:30) ueberlappt den Anruf (01:00-02:00), beide teilen sich die Breite: '
    + `${JSON.stringify([layout.get(schwanz), layout.get(anruf)])}`);
  assert(layout.get(schwanz).colIndex !== layout.get(anruf).colIndex,
    'zwei ueberlappende Bloecke duerfen nicht deckungsgleich uebereinander liegen');

  assert(layout.get(kopf)?.totalCols === 1,
    'der Kopf (22:00-24:00) ueberlappt nichts und bleibt volle Breite - genau dieser Wert '
    + `hat vorher den des Schwanzes ueberschrieben und ihn ueber den Anruf gelegt: ${JSON.stringify(layout.get(kopf))}`);
});

test('layoutOverlaps: am Starttag reicht der Nacht-Termin bis Mitternacht und teilt sich die Spalte mit 23:00 (#1313)', () => {
  const nacht = overnightEvent();
  const anruf = {
    id: 4133, title: 'Anruf', all_day: 0, assigned_users: [],
    start_datetime: '2026-06-14T23:00', end_datetime: '2026-06-14T23:30',
  };
  const layout = calendarHelpers.layoutOverlaps([nacht, anruf], '2026-06-14');
  assert(layout.get(nacht)?.totalCols === 2 && layout.get(anruf)?.totalCols === 2,
    '22:00-24:00 und 23:00-23:30 ueberlappen sich: ohne Klammerung auf den Tag bleibt die Spanne des '
    + `Nacht-Termins 22:00-22:30 und die beiden wissen nichts voneinander: `
    + `${JSON.stringify([layout.get(nacht), layout.get(anruf)])}`);
  assert(layout.get(nacht).colIndex !== layout.get(anruf).colIndex,
    'zwei ueberlappende Bloecke duerfen nicht deckungsgleich uebereinander liegen');
});

// --------------------------------------------------------
// PR #1323 Review, Befund 1: der Zeit-Text am Block meint den TAG, auf dem er
// steht.
//
// Solange beide Spalten "22:00-01:30" trugen, stand in der zweiten etwas
// Falsches ueber diesen Tag: der Block liegt dort an Mitternacht und ist um
// 01:30 vorbei - der Text nannte trotzdem einen Abend, den dieser Tag nicht
// hat.
//
// Die Form ist abgelesen, nicht erfunden. renderAgendaEvent() fragt
// agendaSegmentKind() und waehlt danach:
//   'start'  -> calendar.spanFrom  mit der START zeit
//   'end'    -> calendar.spanUntil mit der END zeit
//   'single' -> der volle Bereich Start bis Ende
// ('all-day'/'middle' erreichen das Raster nicht: was dort landet, ist kuerzer
// als 24 Stunden und beruehrt darum hoechstens zwei Tage.) Das Raster ahmt
// genau das nach - der letzte Test hier vergleicht deshalb Raster und Agenda
// fuer DENSELBEN Tag, Zeichen fuer Zeichen.
// --------------------------------------------------------

const { t: tStub, formatTime: formatTimeStub } = await import('/i18n.js');
const { esc: escStub } = await import('/utils/html.js');

// Der Text der Zeit-Zeile eines Zeitblocks, je Spalte/Ansicht.
function weekEventTimeTexts(html) {
  return [...html.matchAll(/class="week-event__when">([^<]*)</g)].map((m) => m[1].trim());
}

function dayEventTimeText(html, id) {
  const from = html.indexOf(`data-id="${id}"`);
  if (from === -1) return '';
  const meta = html.indexOf('class="day-event__meta"', from);
  if (meta === -1) return '';
  return (/>([^<]*)</.exec(html.slice(meta)) ?? ['', ''])[1].trim();
}

// Die Zeit-Zelle EINER Agenda-Zeile, ueber id UND Tag - derselbe Termin steht
// mit derselben id an beiden Tagen.
function agendaTimeText(html, id, dayStr) {
  const from = html.indexOf(`data-id="${id}" data-date="${dayStr}"`);
  if (from === -1) return '';
  const cell = html.indexOf('calendar-meta-item--time', from);
  if (cell === -1) return '';
  return (/<span>([^<]*)<\/span>/.exec(html.slice(cell)) ?? ['', ''])[1].trim();
}

test('renderWeekView: der Zeit-Text nennt in jeder Spalte den Anteil DIESES Tages (PR #1323, Befund 1)', () => {
  const nacht = overnightEvent();
  const abTagEins  = tStub('calendar.spanFrom',  { time: formatTimeStub(nacht.start_datetime) });
  const bisTagZwei = tStub('calendar.spanUntil', { time: formatTimeStub(nacht.end_datetime) });

  withOvernightState({ events: [overnightEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    const tagEins = weekEventTimeTexts(weekColumnHtml(container.html, '2026-06-14'));
    const tagZwei = weekEventTimeTexts(weekColumnHtml(container.html, '2026-06-15'));
    assert(tagEins.length === 1 && tagZwei.length === 1,
      `Vorbedingung: je ein Zeitblock pro Spalte: ${JSON.stringify([tagEins, tagZwei])}`);
    assert(tagZwei[0] === bisTagZwei,
      `am 15. liegt der Block an Mitternacht und ist um 01:30 vorbei - der Text muss "${bisTagZwei}" `
      + `sagen und nicht den ganzen Termin: ${tagZwei[0]}`);
    assert(tagEins[0] === abTagEins,
      `am 14. beginnt der Termin und endet nicht - wie in der Agenda "${abTagEins}": ${tagEins[0]}`);
  });
});

test('renderDayView: der Zeit-Text am zweiten Tag sagt "bis", ein eintaegiger Termin behaelt den Bereich (PR #1323, Befund 1)', () => {
  const nacht  = overnightEvent();
  const morgen = morningEvent();
  const bisTagZwei = tStub('calendar.spanUntil', { time: formatTimeStub(nacht.end_datetime) });

  withOvernightState({ cursor: '2026-06-15', events: [overnightEvent(), morningEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const nachtText  = dayEventTimeText(container.html, nacht.id);
    const morgenText = dayEventTimeText(container.html, morgen.id);
    assert(nachtText === bisTagZwei,
      `die Tagesansicht des 15. muss "${bisTagZwei}" zeigen: ${nachtText}`);
    // Und der Fall, der sich NICHT aendern darf: ein Termin ganz innerhalb
    // eines Tages nennt weiter Start und Ende.
    assert(!morgenText.startsWith('calendar.span')
      && morgenText.includes(formatTimeStub(morgen.start_datetime))
      && morgenText.includes(formatTimeStub(morgen.end_datetime)),
      `ein eintaegiger Termin behaelt den vollen Bereich: ${morgenText}`);
  });
});

// Die Agenda staggert ihre Zeilen und braucht dafuer querySelectorAll - die
// eine DOM-Oberflaeche mehr als das Zeitraster.
function fakeAgendaContainer() {
  const container = fakeContainer();
  return { ...container, querySelectorAll: () => [], get html() { return container.html; } };
}

test('Zeitraster und Agenda sagen fuer denselben Tag denselben Zeit-Text (PR #1323, Befund 1)', () => {
  withOvernightState({ cursor: '2026-06-15', events: [overnightEvent()] }, () => {
    const raster = fakeContainer();
    calendarHelpers.renderDayView(raster);
    const agenda = fakeAgendaContainer();
    calendarHelpers.renderAgendaView(agenda);

    const rasterText = dayEventTimeText(raster.html, 4131);
    const agendaText = agendaTimeText(agenda.html, 4131, '2026-06-15');
    assert(agendaText !== '', 'Vorbedingung: die Agenda muss den Nacht-Termin am 15. auffuehren');
    assert(escStub(rasterText) === agendaText,
      `beide Ansichten beantworten dieselbe Frage ueber denselben Tag und muessen dasselbe sagen - `
      + `Raster: ${rasterText} / Agenda: ${agendaText}`);
  });
});

// --------------------------------------------------------
// Die Uhrzeit am Ganztags-Chip (#1350, entschieden in D#1081)
//
// Ein ZEITGEBUNDENER Termin ab 24 Stunden bleibt in der Ganztags-Zeile - das
// ist die andere Haelfte der Entscheidung, deren kurzen Fall #1313 gebaut hat.
// Der Chip trug dort aber keine Uhrzeit: 14:00 bis 11:00 zwei Tage spaeter sah
// an allen drei Tagen aus wie drei ganze Tage.
//
// Die Regel, wie im Faden zugesagt: am ersten Tag die Startzeit, am letzten die
// Endzeit, dazwischen nichts; echte Ganztags-Termine unveraendert; ein Ende um
// exakt 00:00 gehoert dem Vortag (#804, eventEndDate()); und KEIN neues
// Vokabular - dieselben Beschriftungen wie die Agenda. Deshalb vergleicht ein
// Test Chip und Agenda fuer denselben Tag Zeichen fuer Zeichen.
//
// Die Tage werden in der ANZEIGEZONE zugeordnet. Der Zonen-Fall weiter unten
// nimmt zwei Instants, deren letzter Tag mit der Zone wandert - eine feste Zone
// allein waere in ihrer Zone gruen und blind in jeder anderen.
// --------------------------------------------------------

// Der Fall aus dem Faden (dort 10. bis 12.), in die Woche von withOvernightState
// gelegt: Sonntag, der 14., 14:00 bis Dienstag, der 16., 11:00 - 45 Stunden.
function longTimedEvent(extra = {}) {
  return {
    id: 4301, title: 'Workshop', all_day: 0, assigned_users: [],
    start_datetime: '2026-06-14T14:00', end_datetime: '2026-06-16T11:00',
    ...extra,
  };
}

// Der Ganztags-Chip eines Termins in einem Stueck Markup: sein title-Attribut
// und seine sichtbare Uhrzeit ('' ohne), oder null, wenn er dort nicht steht.
function alldayChip(html, id) {
  const m = new RegExp(`<div class="allday-event(?: cal-band[^"]*)?" data-id="${id}"[^>]*?title="([^"]*)">([\\s\\S]*?)</div>`).exec(html);
  if (!m) return null;
  const time = /class="allday-event__time">([^<]*)</.exec(m[2]);
  return { title: m[1], time: time ? time[1] : '' };
}

// Das, was der Chip sagen soll - ueber dieselben (gestubbten) Funktionen, die
// auch die Agenda ruft, und escaped wie im Markup.
const abZeit  = (ev) => escStub(tStub('calendar.spanFrom',  { time: formatTimeStub(ev.start_datetime) }));
const bisZeit = (ev) => escStub(tStub('calendar.spanUntil', { time: formatTimeStub(ev.end_datetime) }));

// Prueft EINEN Tag: kein Chip (erwartet === null), ein Chip ohne Uhrzeit
// (erwartet === '') oder ein Chip mit genau dieser Uhrzeit - sichtbar UND im
// title, der den Tooltip und den zugaenglichen Namen traegt.
function assertChipTime(chip, erwartet, wo) {
  if (erwartet === null) {
    assert(chip === null, `${wo}: an diesem Tag darf kein Chip stehen: ${JSON.stringify(chip)}`);
    return;
  }
  assert(chip !== null, `${wo}: an diesem Tag muss der Chip stehen`);
  if (erwartet === '') {
    assert(chip.time === '', `${wo}: dieser Tag bekommt keine Uhrzeit: ${chip.time}`);
    assert(!chip.title.includes('calendar.span'), `${wo}: auch der title nennt keine Uhrzeit: ${chip.title}`);
    return;
  }
  assert(chip.time === erwartet, `${wo}: sichtbar muss "${erwartet}" stehen: "${chip.time}"`);
  assert(chip.title.includes(erwartet), `${wo}: der title muss "${erwartet}" tragen: ${chip.title}`);
}

// DIE WOCHE ZEICHNET DEN TERMIN ALS EIN BAND (Re-Kritik 2026-09-25): statt
// eines Chips je Tag steht EIN Balken ueber seinen Spalten, das „ab" vorne,
// das „bis" am Ende. Die Tagesfrage bleibt dieselbe - was steht an Tag X? -,
// gelesen am Band: an seiner ersten Spalte das „ab", an seiner letzten das
// „bis", dazwischen nichts, ausserhalb kein Termin. Zusaetzlich gilt: genau
// EIN Band, und in keiner Tageszelle ein Chip desselben Termins.
function weekBand(events, id) {
  let html = '';
  withOvernightState({ events }, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    html = container.html;
  });
  const row = html.slice(html.indexOf('class="allday-row'), html.indexOf('week-view__scroll'));
  const bars = [...row.matchAll(new RegExp(`<div class="allday-event cal-band[^"]*" data-id="${id}" data-start="([^"]+)" data-end="([^"]+)"[^>]*?title="([^"]*)">([\\s\\S]*?)</div>`, 'g'))];
  const cellChips = row.split(/<div class="allday-cell"/).slice(1).filter((cell) => cell.includes(`data-id="${id}"`)).length;
  assert(bars.length === 1, `genau EIN Band erwartet, gefunden: ${bars.length}`);
  assert(cellChips === 0, `neben dem Band darf keine Tageszelle den Termin als Chip tragen: ${cellChips}`);
  const [, start, end, title, inner] = bars[0];
  const from = /class="allday-event__time">([^<]*)</.exec(inner);
  const until = /cal-band__until">([^<]*)</.exec(inner);
  return { start, end, title, from: from ? from[1] : '', until: until ? until[1] : '' };
}

function weekChips(events, id) {
  const band = weekBand(events, id);
  return (day) => {
    if (day < band.start || day > band.end) return null;
    if (day === band.start) return { time: band.from, title: band.title };
    if (day === band.end) return { time: band.until, title: band.title };
    return { time: '', title: band.title };
  };
}

// Wie assertChipTime, am Band gelesen: der title des Bands nennt die ganze
// Spanne (Anfang UND Ende), deshalb prueft er hier nur, dass die sichtbare
// Uhrzeit darin vorkommt.
function assertBandTime(chip, erwartet, wo) {
  if (erwartet === null) {
    assert(chip === null, `${wo}: an diesem Tag darf das Band nicht stehen: ${JSON.stringify(chip)}`);
    return;
  }
  assert(chip !== null, `${wo}: an diesem Tag muss das Band stehen`);
  assert(chip.time === erwartet, `${wo}: sichtbar muss "${erwartet}" stehen: "${chip.time}"`);
  if (erwartet) assert(chip.title.includes(erwartet), `${wo}: der title muss "${erwartet}" tragen: ${chip.title}`);
}

function dayChip(events, id, day) {
  let chip;
  withOvernightState({ cursor: day, events }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    chip = alldayChip(container.html, id);
  });
  return chip;
}

test('renderWeekView: ein Termin ab 24 Stunden ist EIN Band - "ab" an seiner ersten, "bis" an seiner letzten Spalte (#1350, Re-Kritik 2026-09-25)', () => {
  const ev = longTimedEvent();
  assert(isAllDayLike(ev) === true, 'Vorbedingung: 45 Stunden stehen in der Ganztags-Zeile');
  const chipAm = weekChips([longTimedEvent()], ev.id);
  assertBandTime(chipAm('2026-06-14'), abZeit(ev),  'Woche, Tag 1');
  assertBandTime(chipAm('2026-06-15'), '',          'Woche, Tag 2');
  assertBandTime(chipAm('2026-06-16'), bisZeit(ev), 'Woche, Tag 3');
  assertBandTime(chipAm('2026-06-17'), null,        'Woche, Tag nach dem Ende');
});

test('renderDayView: ein Termin ab 24 Stunden sagt "ab" am ersten und "bis" am letzten Tag, dazwischen nichts (#1350)', () => {
  const ev = longTimedEvent();
  assertChipTime(dayChip([longTimedEvent()], ev.id, '2026-06-14'), abZeit(ev),  'Tag 1');
  assertChipTime(dayChip([longTimedEvent()], ev.id, '2026-06-15'), '',          'Tag 2');
  assertChipTime(dayChip([longTimedEvent()], ev.id, '2026-06-16'), bisZeit(ev), 'Tag 3');
});

test('Ganztags-Chip: ein echter Ganztags-Termin bekommt an keinem Tag eine Uhrzeit (#1350)', () => {
  // Beide Speicherformen: Ende als T00:00, das INKLUSIV gemeint ist, und reines Datum.
  const formen = [
    { id: 4302, title: 'Urlaub', all_day: 1, assigned_users: [],
      start_datetime: '2026-06-14T00:00', end_datetime: '2026-06-16T00:00' },
    { id: 4303, title: 'Messe', all_day: 1, assigned_users: [],
      start_datetime: '2026-06-14', end_datetime: '2026-06-16' },
  ];
  for (const ev of formen) {
    const chipAm = weekChips([{ ...ev }], ev.id);
    for (const day of ['2026-06-14', '2026-06-15', '2026-06-16']) {
      assertBandTime(chipAm(day), '', `Woche, ${ev.start_datetime}, ${day}`);
      assertChipTime(dayChip([{ ...ev }], ev.id, day), '', `Tag, ${ev.start_datetime}, ${day}`);
    }
  }
});

test('Ganztags-Chip: endet der Termin exakt um Mitternacht, steht das "bis" am Vortag (#1350, #804)', () => {
  // 14:00 am 14. bis 00:00 am 17.: eventEndDate() zieht das Ende auf den 16.,
  // der 17. zeigt den Termin gar nicht.
  const ev = longTimedEvent({ id: 4304, end_datetime: '2026-06-17T00:00' });
  assert(calendarHelpers.eventEndDate(ev) === '2026-06-16', 'Vorbedingung: der letzte Tag ist der 16.');
  const chipAm = weekChips([{ ...ev }], ev.id);
  assertBandTime(chipAm('2026-06-14'), abZeit(ev),  'Woche, Starttag');
  assertBandTime(chipAm('2026-06-15'), '',          'Woche, dazwischen');
  assertBandTime(chipAm('2026-06-16'), bisZeit(ev), 'Woche, Vortag der Mitternacht');
  assertBandTime(chipAm('2026-06-17'), null,        'Woche, der Tag, an dem um 00:00 Schluss ist');
  assertChipTime(dayChip([{ ...ev }], ev.id, '2026-06-16'), bisZeit(ev), 'Tag, Vortag der Mitternacht');
  assertChipTime(dayChip([{ ...ev }], ev.id, '2026-06-17'), null,        'Tag, der Tag, an dem um 00:00 Schluss ist');
});

test('Ganztags-Chip: welcher Tag "ab" und welcher "bis" sagt, folgt der ANZEIGEZONE (#1350)', () => {
  // Dieselben zwei Zeitpunkte, drei Haushalte:
  //   Europe/Berlin (+02:00):      14. 14:00 bis 17. 00:30 - "bis" am 17.
  //   UTC:                         14. 12:00 bis 16. 22:30 - "bis" am 16., der 17. ohne Chip
  //   Pacific/Kiritimati (+14:00): 15. 02:00 bis 17. 12:30 - "ab" erst am 15.
  const instants = { id: 4305, start_datetime: '2026-06-14T12:00:00Z', end_datetime: '2026-06-16T22:30:00Z' };
  const ev = longTimedEvent(instants);
  const erwartet = {
    'Europe/Berlin':      { '2026-06-14': abZeit(ev), '2026-06-15': '', '2026-06-16': '',         '2026-06-17': bisZeit(ev) },
    UTC:                  { '2026-06-14': abZeit(ev), '2026-06-15': '', '2026-06-16': bisZeit(ev), '2026-06-17': null },
    'Pacific/Kiritimati': { '2026-06-14': null,       '2026-06-15': abZeit(ev), '2026-06-16': '',  '2026-06-17': bisZeit(ev) },
  };
  for (const [zone, tage] of Object.entries(erwartet)) {
    withDisplayTimeZone(zone, () => {
      const chipAm = weekChips([longTimedEvent(instants)], ev.id);
      for (const [day, soll] of Object.entries(tage)) {
        assertBandTime(chipAm(day), soll, `${zone}, Woche, ${day}`);
        assertChipTime(dayChip([longTimedEvent(instants)], ev.id, day), soll, `${zone}, Tag, ${day}`);
      }
    });
  }
});

test('Ganztags-Chip und Agenda sagen fuer denselben Tag dieselbe Uhrzeit (#1350)', () => {
  // "Those labels already exist, because the agenda uses them": kein eigenes
  // Vokabular, auch kein eigenes Format - Zeichen fuer Zeichen dasselbe.
  const ev = longTimedEvent();
  for (const day of ['2026-06-14', '2026-06-16']) {
    const chip = dayChip([longTimedEvent()], ev.id, day);
    let agendaText = '';
    withOvernightState({ cursor: day, events: [longTimedEvent()] }, () => {
      const agenda = fakeAgendaContainer();
      calendarHelpers.renderAgendaView(agenda);
      agendaText = agendaTimeText(agenda.html, ev.id, day);
    });
    assert(agendaText !== '', `Vorbedingung: die Agenda muss den Termin am ${day} auffuehren`);
    assert(chip && chip.time === agendaText,
      `am ${day} muessen Chip und Agenda dasselbe sagen - Chip: ${chip?.time} / Agenda: ${agendaText}`);
  }
});

test('Ganztags-Chip: der Kalendername im title ist escaped (#1350)', () => {
  // Der title wird mit der Uhrzeit neu zusammengesetzt; der Kalendername (auch
  // der Name eines ICS-Abos) lief dort bisher als EINZIGER Teil ungeescaped
  // hinein - die Monatsansicht escaped ihn laengst.
  const ev = longTimedEvent({ cal_name: 'Familie "Nord" & Co' });
  let html = '';
  withOvernightState({ events: [ev] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    html = container.html;
  });
  assert(html.includes('Familie &quot;Nord&quot; &amp; Co'), 'der Kalendername muss escaped im title stehen');
  assert(!html.includes('"Nord"'), 'ein rohes Anfuehrungszeichen beendet das title-Attribut mitten im Namen');
});

// Die Rangfolge im engen Chip ist entschieden (PR #1360): DER TITEL GEWINNT.
// Er behaelt eine Mindestbreite; passt die Uhrzeit daneben nicht mehr, faellt
// sie auf diesem Chip GANZ weg - kein Stumpf, keine Ellipse. title-Attribut und
// Detailansicht nennen sie weiter.
//
// Node rechnet kein Layout; gemessen ist es im Browser (Tabelle im PR). Hier
// steht, was die Messung traegt: Titel und Uhrzeit teilen sich EINE
// umbrechende Zeile von einer Zeilenhoehe mit abgeschnittenem Rest, der Titel
// bricht mit seiner Mindestbreite um (Flex-Basis aus den Tokens, geklemmt auf
// max-content, damit ein kurzer Titel keine Uhrzeit blockiert, die neben ihn
// passt), und die Uhrzeit kann nicht schrumpfen und nicht gekuerzt werden -
// sie steht ganz in Zeile eins oder ganz in der unsichtbaren zweiten. Die
// Zugewiesenen stehen ausserhalb dieser Zeile; wann sie weichen, regelt seit
// der Re-Kritik 2026-09-25 die Zeile darum (Test unten).
test('Ganztags-Chip: der Titel gewinnt - die Uhrzeit steht ganz da oder gar nicht (PR #1360)', () => {
  // (a) Markup: Titel und Uhrzeit in derselben Zeile, die Zugewiesenen dahinter.
  const ev = longTimedEvent({ assigned_users: [{ id: 1, display_name: 'Linda' }] });
  let html = '';
  withOvernightState({ cursor: '2026-06-14', events: [ev] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    html = container.html;
  });
  const label = /<span class="allday-event__label"><span>[^<]*<\/span><small class="allday-event__time">[^<]*<\/small><\/span>/.exec(html);
  assert(label, 'Titel und Uhrzeit muessen zusammen in .allday-event__label stehen, die Uhrzeit direkt hinter dem Titel');
  const nachLabel = html.slice(label.index + label[0].length);
  assert(nachLabel.trimStart().startsWith('<span class="cal-chip__assigned">'),
    'die Zugewiesenen stehen HINTER dem Label, nicht in ihm - sonst braechen sie mit der Uhrzeit um');

  // (b) Stylesheet: die Mechanik, die im Browser gemessen ist.
  const regeln = [...eachRule(calendarCss)];
  const zeile = regeln.find((rule) => rule.selector.trim() === '.allday-event__label');
  assert(zeile, 'es braucht eine Regel fuer .allday-event__label');
  assert(/display:\s*flex/.test(zeile.body) && /flex-wrap:\s*wrap/.test(zeile.body),
    `die Zeile muss umbrechen, damit eine Uhrzeit, die nicht passt, als Ganzes in Zeile zwei rutscht: ${zeile.body}`);
  assert(/(?:^|[\s;])(?:max-)?height:\s*1lh/.test(zeile.body) && /overflow:\s*hidden/.test(zeile.body),
    `die Zeile ist genau eine Zeilenhoehe hoch und schneidet den Rest ab - Zeile zwei bleibt unsichtbar: ${zeile.body}`);

  const titel = regeln.find((rule) => /\.allday-event__label\s*>\s*span:has\(\s*\+\s*\.allday-event__time\s*\)/.test(rule.selector));
  assert(titel, 'es braucht eine Regel fuer den Titel VOR der Uhrzeit');
  assert(/flex:\s*1\s+1\s+var\(--space-\w+\)/.test(titel.body) || /flex-basis:\s*var\(--space-\w+\)/.test(titel.body),
    `der Titel bricht mit einer Mindestbreite aus den Tokens um (Flex-Basis), nicht mit seiner vollen Laenge - `
    + `sie entscheidet, wann die Uhrzeit wegfaellt: ${titel.body}`);
  assert(/max-width:\s*max-content/.test(titel.body),
    `ein kurzer Titel klemmt die Mindestbreite auf seine eigene Breite und blockiert keine Uhrzeit, die neben ihn passt: ${titel.body}`);

  const zeit = regeln.find((rule) => rule.selector.trim() === '.allday-event__time');
  assert(zeit, 'es braucht eine Regel fuer .allday-event__time');
  assert(/flex:\s*none/.test(zeit.body) || /flex-shrink:\s*0/.test(zeit.body) || /flex:\s*0\s+0\s+auto/.test(zeit.body),
    `die Uhrzeit darf nicht schrumpfen - ganz oder gar nicht: ${zeit.body}`);
  assert(!/text-overflow/.test(zeit.body) && !/min-width:\s*0/.test(zeit.body),
    `die Uhrzeit wird nie gekuerzt, auch nicht per Ellipse: ${zeit.body}`);
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
  const basis = { assignedToMe: false, people: new Set(), holidayPrefs: {}, layerBirthdays: true, layerSchedule: true, layerWaste: true, wasteVisibleTypeIds: new Set() };
  // scheduleEnabled()/wasteEnabled() fragen window.yuvomi - ohne Modul-Registry gelten Schichtplan
  // und Waste als an, deshalb steht layerWaste hier explizit auf "sichtbar" wie layerSchedule.
  // Am Zaehler aendert der Wert nichts mehr (die ausgeschaltete Ebene zaehlt seit 7de80c16 nicht
  // als Filter) - er haelt diesen Test nur unabhaengig von der Waste-Achse, die er nicht prueft.
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
// scheduleEnabled(): Modul-Abschaltung UND Leserechte
// ANLASS: ein Mitglied mit Schedule-Recht 'none' sah trotzdem die Ebenen-Zeile
// im Filter-Blatt UND loeste bei jedem Kalender-Laden ein garantiertes 403 auf
// GET /schedule/entries aus. scheduleEnabled() ist (anders als wasteEnabled(),
// s. test-waste-calendar.js) nicht in __test exportiert, also kein direkter
// Aufruf hier moeglich - Quelltext-Pruefung, wie fuer andere Funktionen ohne
// eigenen Export in dieser Datei bereits ueblich (s. z.B. die
// calendarRepeatIconHtml-Region-Pruefung oben).
// --------------------------------------------------------
test('scheduleEnabled() verlangt zusaetzlich moduleAccess(\'schedule\') !== \'none\', wie wasteEnabled() es fuer waste tut', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert(/import \{ moduleAccess \} from '\/permissions\.js';/.test(src), 'moduleAccess muss importiert sein');
  const fnBody = src.slice(src.indexOf('function scheduleEnabled()'), src.indexOf('function wasteEnabled()'));
  assert(/isModuleDisabled\?\.\('schedule'\)/.test(fnBody), 'die bestehende Abschaltungs-Pruefung darf nicht verschwinden');
  assert(/moduleAccess\('schedule'\) !== 'none'/.test(fnBody),
    'scheduleEnabled() muss wie wasteEnabled() auch die Leserechte pruefen, nicht nur die Abschaltung - '
    + 'sonst sieht ein Mitglied ohne Schedule-Recht weiter die Ebenen-Zeile und loest bei jedem Laden ein 403 aus');
});

// --------------------------------------------------------
// Mobile Inhaltsflaeche (Critique 2026-09-24, P1)
// --------------------------------------------------------

/* FILTER UND SUCHE WOHNEN IN DER BAR-ZEILE, NICHT IM AKTIONS-SLOT.
 *
 * Im Aktions-Slot bildeten sie mobil eine eigene Kopfzeile (56px fuer zwei
 * Knoepfe) und standen je nach Kollaps-Zustand links oder rechts. Geprueft
 * wird das GERENDERTE Markup des Kopfs: beide Knoepfe stehen in
 * `.page-toolbar__bar`, HINTER der Tab-Leiste, und der Aktions-Slot enthaelt
 * keinen von beiden. */
test('Kalenderkopf: Filter und Suche stehen in der Bar-Zeile hinter dem Ansichts-Segment, nicht im Aktions-Slot', () => {
  const html = calendarHelpers.toolbarHtml({ filterCount: 0, scheduleWarningHtml: '' });
  const at = (needle) => html.indexOf(needle);
  const actions = at('class="page-toolbar__actions"');
  const bar = at('class="page-toolbar__bar');
  const tablist = at('role="tablist"');
  const filters = at('id="cal-filters"');
  const search = at('id="cal-search"');
  assert(actions >= 0 && bar >= 0 && tablist >= 0, 'Kopf ohne Aktions-Slot, Bar-Zeile oder Tab-Leiste gerendert');
  assert(filters >= 0 && search >= 0, 'Filter- oder Suchknopf fehlt im Kopf');
  assert(bar > actions, 'die Bar-Zeile muss nach dem Aktions-Slot stehen');
  assert(filters > bar && search > bar,
    `Filter (${filters}) und Suche (${search}) muessen IN der Bar-Zeile stehen (ab ${bar}), `
    + 'nicht im Aktions-Slot - dort bauten sie mobil eine eigene Kopfzeile');
  assert(filters > tablist && search > tablist,
    'Filter und Suche gehoeren HINTER das Ansichts-Segment, ans Ende der Bar-Zeile');
  const actionsHtml = html.slice(actions, bar);
  assert(!actionsHtml.includes('cal-filters') && !actionsHtml.includes('cal-search'),
    'der Aktions-Slot darf Filter oder Suche nicht (auch nicht zusaetzlich) tragen');
});

/* EINGEKLAPPT VERLAESST DER TITEL DAS BILD, NICHT DEN BAUM.
 *
 * Vorher fiel er nur auf den Inline-Schnitt und blieb auf seiner eigenen
 * Zeile: der Kollaps sparte 5-14px. Die Regel muss den Titel aus dem Fluss
 * nehmen und klippen (das <h1> bleibt fuer Screenreader), sonst bleibt die
 * Zeile stehen. */
test('Kalenderkopf: eingeklappt klappt die Titelzeile ganz ein (Titel geclippt, Siegel weg)', () => {
  // Die Regel ist seit der Budget-Critique 2026-09-25 geteilt: layout.css
  // fuehrt sie fuer jeden Kopf mit Zeitraum (`.page-toolbar--period`), und der
  // Kalenderkopf muss die Klasse tragen - sonst gilt sie fuer ihn nicht.
  const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(layoutCss)];
  const title = rules.find((r) => r.selector.split(',').map((x) => x.trim())
    .includes('.page-toolbar--period.page-toolbar--capped.is-collapsed > .page-toolbar__title'));
  assert(title, 'keine geteilte Regel fuer den eingeklappten Titel eines Zeitraum-Kopfs');
  assert(/position:\s*absolute/.test(title.body) && /clip-path:\s*inset\(50%\)/.test(title.body),
    'der eingeklappte Titel muss aus dem Fluss (position: absolute) und geclippt sein - '
    + 'display: none nimmt der Seite ihre Ueberschrift');
  assert(!/display:\s*none/.test(title.body), 'das <h1> darf nicht per display: none verschwinden');
  const seal = rules.find((r) => r.selector.trim()
    === '.page-toolbar--period.page-toolbar--capped.is-collapsed > .module-seal--head');
  assert(seal && /display:\s*none/.test(seal.body), 'das Absender-Siegel muss mit dem Titel einklappen');
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert(/<div class="page-toolbar[^"]*\bpage-toolbar--period\b[^"]*\bcal-toolbar\b[^"]*" id="cal-toolbar">/.test(src),
    'der Kalenderkopf muss `page-toolbar--period` tragen, sonst klappt sein Titel nicht ganz ein');
});

/* DAS LABEL HAT EINE FESTE BREITE. Mit `flex-basis: auto` brachte es seine
 * Textbreite mit (Monat 156px, Tag 186px), und der Weiter-Pfeil sprang beim
 * Ansichtswechsel 30px. */
test('Zeitraum-Label: Basis 0 statt Textbreite, damit die Pfeile nicht springen', () => {
  const label = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.cal-toolbar__label');
  assert(label, '.cal-toolbar__label fehlt');
  assert(/flex:\s*1 1 0(?:px|%)?\s*(;|$)/.test(label.body),
    `das Label muss flex: 1 1 0 tragen (feste Breite aus dem Rest der Zeile), hat: ${label.body.match(/flex:[^;]+/)?.[0]}`);
});

/* DIE STUNDENLEISTE PASST IN 44px. „12:00 PM" braucht ~50px; im
 * 12-Stunden-Format beschriftet sie volle Stunden ohne „:00". */
test('Stundenleiste: volle Stunden, im 12-Stunden-Format ohne „:00"', () => {
  // Die Schreibweise, die formatTime im 12-Stunden-Format liefert (i18n.js):
  // `${h % 12 || 12}:${mm} ${AM|PM}`. Der Browser-Loader stubbt formatTime,
  // deshalb wird die Kuerzung hier an ihrer eigenen Funktion geprueft.
  assert(calendarHelpers.compactHourLabel('8:00 AM') === '8 AM', calendarHelpers.compactHourLabel('8:00 AM'));
  assert(calendarHelpers.compactHourLabel('12:00 PM') === '12 PM', calendarHelpers.compactHourLabel('12:00 PM'));
  assert(calendarHelpers.compactHourLabel('08:00') === '08:00', '24-Stunden-Schreibweise bleibt unveraendert');
  assert(calendarHelpers.compactHourLabel('08.00') === '08.00', 'die Locale-Schreibweise (id) bleibt unveraendert');
  // Und die Stundenleiste benutzt sie - in Woche UND Tag.
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const uses = src.match(/<span class="week-view__time-label">\$\{h === 0 \? '' : hourGutterLabel\(h\)\}<\/span>/g) ?? [];
  assert(uses.length === 2, `Woche und Tag muessen hourGutterLabel verwenden, gefunden: ${uses.length}`);
});

/* WISCHEN ZWISCHEN ZEITRAEUMEN: die Entscheidungen der Geste als reine
 * Funktionen - Schwelle, Richtungssperre, Rand, Leserichtung. Dass die Geste
 * im Dokument verdrahtet ist, sieht nur der Browser (gemessen beim Bau). */
test('Zeitraum-Wisch: Schwelle, Richtungssperre, Systemrand und RTL', () => {
  const swipe = periodSwipe;
  // Schwelle: dieselbe wie die Wischzeilen (80px).
  assert(swipe.periodSwipeStep(-79) === 0, 'unter 80px blaettert nichts');
  assert(swipe.periodSwipeStep(-80) === 1, 'LTR: nach links = naechster Zeitraum');
  assert(swipe.periodSwipeStep(120) === -1, 'LTR: nach rechts = vorheriger Zeitraum');
  assert(swipe.periodSwipeStep(-120, { rtl: true }) === -1, 'RTL: nach links = vorheriger Zeitraum');
  assert(swipe.periodSwipeStep(120, { rtl: true }) === 1, 'RTL: nach rechts = naechster Zeitraum');
  // Richtungssperre: senkrecht gewinnt, sobald es mehr senkrecht ist.
  assert(swipe.periodSwipeLock(5, 5) === null, 'innerhalb der Toleranz ist noch nichts entschieden');
  assert(swipe.periodSwipeLock(10, 40) === 'scroll', 'ueberwiegend senkrecht ist Scrollen');
  assert(swipe.periodSwipeLock(30, 10) === 'swipe', 'ueberwiegend waagerecht ist die Geste');
  // Der Rand gehoert der Zurueck-Geste des Systems.
  assert(swipe.startsAtScreenEdge(10, 375) && swipe.startsAtScreenEdge(365, 375),
    'ein Kontakt naeher als 20px an der Kante gehoert dem System');
  assert(!swipe.startsAtScreenEdge(40, 375), 'ein Kontakt im Inhalt gehoert der Geste');
});

/* Ein zweiter Finger MITTEN im Wisch (PR #1460, Review): sein touchstart kam
 * zuerst und setzte die Sperre auf 'off' - damit erreichte onMove seinen
 * Mehrfinger-Zweig nie, onEnd stieg ohne reset aus, und der Inhalt blieb bis
 * zum naechsten Rendern um den Wischweg verschoben stehen. */
test('Zeitraum-Wisch: ein zweiter Finger mitten im Wisch setzt den Inhalt zurueck', () => {
  const zuvor = { window: globalThis.window, document: globalThis.document };
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }), innerWidth: 375 };
    globalThis.document = { getElementById: () => null, documentElement: { dir: '' } };
    const handlers = {};
    const child = { style: {}, isConnected: true, classList: { add() {}, remove() {} } };
    const surface = {
      firstElementChild: child,
      addEventListener: (type, fn) => { handlers[type] = fn; },
      removeEventListener() {},
      closest: () => null,
    };
    let steps = 0;
    periodSwipe.wirePeriodSwipe(surface, { enabled: () => true, onStep: () => { steps++; } });
    const target = { closest: () => null };
    const at = (x, y) => ({ clientX: x, clientY: y });

    handlers.touchstart({ touches: [at(200, 300)], target });
    handlers.touchmove({ touches: [at(150, 302)], cancelable: true, preventDefault() {} });
    assert(child.style.transform, 'Vorbedingung: der Inhalt folgt dem Finger');

    handlers.touchstart({ touches: [at(150, 302), at(300, 400)], target });
    assert(!child.style.transform, `der zweite Finger muss den Wisch abbrechen, Transform: ${child.style.transform}`);
    handlers.touchend({ touches: [] });
    assert(steps === 0, 'ein abgebrochener Wisch blaettert nicht');
  } finally {
    globalThis.window = zuvor.window;
    globalThis.document = zuvor.document;
  }
});

// --------------------------------------------------------
// Tastatur und Screenreader (Critique 2026-09-24, P1, Schritt 3)
//
// Vorher: Terminbloecke in Woche und Tag trugen `cursor: pointer` und sonst
// nichts, das Monatsraster war 35-42 einzelne role="button"-Tab-Stopps ohne
// Pfeiltasten, die Prioritaet einer Aufgabe stand nur im aria-hidden-Punkt und
// die Ansichts-Tablist hiess wie die H1. Gemessen wird am GERENDERTEN Markup.
// --------------------------------------------------------

function withMonthState(extra, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const hadRO = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver');
  const previousRO = globalThis.ResizeObserver;
  try {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    withOvernightState({ cursor: '2026-09-24', today: '2026-09-24', weekStart: 1, ...extra }, fn);
  } finally {
    if (hadRO) globalThis.ResizeObserver = previousRO; else delete globalThis.ResizeObserver;
    if (hadWindow) globalThis.window = previousWindow;
  }
}

test('Monatsraster ist EIN ARIA-Grid mit EINEM Tab-Stopp: grid > row > gridcell, roving tabindex', () => {
  withMonthState({}, () => {
    const container = fakeContainer();
    calendarHelpers.renderMonthView(container);
    const html = container.html;
    assert(/class="month-view[^"]*"[^>]*role="grid"/.test(html), 'die Monatsflaeche traegt kein role="grid"');
    assert(/role="grid" aria-labelledby="cal-label"/.test(html), 'das Grid muss nach dem Zeitraum-Label heissen');
    const weeks = calendarHelpers.monthGridSpan('2026-09-24').weeks;
    const rows = (html.match(/class="month-grid__row" role="row"/g) ?? []).length;
    assert(rows === weeks, `je Woche eine role=row erwartet (${weeks}), gefunden ${rows}`);
    const cells = [...html.matchAll(/class="month-day[^"]*" data-date="([^"]+)"[^>]*role="gridcell" tabindex="(0|-1)"/g)];
    assert(cells.length === weeks * 7, `alle Tage muessen gridcells sein: ${cells.length} von ${weeks * 7}`);
    const stops = cells.filter((m) => m[2] === '0').map((m) => m[1]);
    assert(stops.length === 1 && stops[0] === '2026-09-24',
      `genau EIN Tab-Stopp, auf dem Cursor - gefunden: ${stops.join(', ') || 'keiner'}`);
    assert(!/class="month-day[^"]*"[^>]*role="button"/.test(html), 'eine Monatszelle ist noch role="button"');
    assert((html.match(/role="columnheader"/g) ?? []).length === 7, 'die Wochentagsleiste muss die Spaltenkoepfe tragen');
  });
});

test('Monatszelle: Auswahl im Telefon-Monat ist aria-selected, nicht aria-pressed; am Desktop keine Auswahl', () => {
  withMonthState({}, () => {
    const split = calendarHelpers.renderMonthDay('2026-09-24', true, { selected: true, split: true, focusable: true });
    assert(/aria-selected="true"/.test(split), 'der gewaehlte Tag muss aria-selected="true" tragen');
    assert(!/aria-pressed/.test(split), 'aria-pressed ist die Semantik eines Umschalters, nicht einer Grid-Auswahl');
    const other = calendarHelpers.renderMonthDay('2026-09-23', true, { split: true });
    assert(/aria-selected="false"/.test(other) && /tabindex="-1"/.test(other), 'ein anderer Tag: nicht gewaehlt, kein Tab-Stopp');
    const desk = calendarHelpers.renderMonthDay('2026-09-24', true, { focusable: true });
    assert(!/aria-selected|aria-pressed/.test(desk), 'am Desktop oeffnet die Zelle den Tag - dort gibt es keine Auswahl');
    const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
    const sel = src.slice(src.indexOf('function selectMonthDay('), src.indexOf('let _monthFocusDate'));
    assert(/aria-selected/.test(sel) && !/aria-pressed/.test(sel), 'selectMonthDay() muss aria-selected nachziehen');
  });
});

test('Monatszelle: der Name nennt Wochentag, heute, Anzahl und die ersten drei Titel', () => {
  const label = calendarHelpers.monthDayAriaLabel('2026-09-24', 5, [
    { title: 'Zahnarzt' }, { title: 'Training', recurrence_rule: 'FREQ=WEEKLY' },
  ], { tasks: [{ title: 'Steuer' }, { title: 'Muell' }], others: ['Feiertag'], isToday: true });
  assert(label.startsWith('calendar.dayLongThursday, '), `der Wochentag fehlt vorn: ${label}`);
  assert(label.includes(', calendar.today, '), `„heute" fehlt: ${label}`);
  // „5 Eintraege" mit drei Titeln nennt den Rest als Zahl (Re-Kritik
  // 2026-09-25): vorher klang die Zelle, als seien es drei.
  assert(label.endsWith('calendar.monthDayEntries{"count":5}: Feiertag, Zahnarzt, calendar.recurringEvent: Training calendar.monthDayMoreTitles{"count":2}'),
    `Anzahl, die ersten drei Titel in Zellreihenfolge und „und 2 weitere" erwartet: ${label}`);
  const empty = calendarHelpers.monthDayAriaLabel('2026-09-25', 0, []);
  assert(!/today|monthDayEntries/.test(empty), `ein leerer Tag nennt nur sein Datum: ${empty}`);
});

test('Monatsraster: Pfeile, Pos1/Ende und Bild auf/ab fuehren zum richtigen Tag (Rand, Wochenstart, RTL)', () => {
  const k = calendarHelpers.monthGridKeyTarget;
  assert(k('2026-09-30', 'ArrowRight', { weekStart: 1 }) === '2026-10-01', 'rechts ueber den Monatsrand');
  assert(k('2026-09-01', 'ArrowLeft', { weekStart: 1 }) === '2026-08-31', 'links ueber den Monatsrand');
  assert(k('2026-09-01', 'ArrowLeft', { weekStart: 1, rtl: true }) === '2026-09-02', 'RTL: links ist vor');
  assert(k('2026-09-24', 'ArrowDown', { weekStart: 1 }) === '2026-10-01', 'runter eine Woche');
  assert(k('2026-09-24', 'ArrowUp', { weekStart: 1 }) === '2026-09-17', 'hoch eine Woche');
  assert(k('2026-09-24', 'Home', { weekStart: 1 }) === '2026-09-21', 'Pos1: Montag bei Wochenstart Montag');
  assert(k('2026-09-24', 'Home', { weekStart: 0 }) === '2026-09-20', 'Pos1: Sonntag bei Wochenstart Sonntag');
  assert(k('2026-09-24', 'End', { weekStart: 1 }) === '2026-09-27', 'Ende: Sonntag bei Wochenstart Montag');
  assert(k('2026-01-31', 'PageDown', { weekStart: 1 }) === '2026-02-28', 'Bild ab vom 31.01. auf den 28.02., nicht in den Maerz');
  assert(k('2026-03-31', 'PageUp', { weekStart: 1 }) === '2026-02-28', 'Bild auf klemmt genauso');
  assert(k('2026-09-24', 'a', { weekStart: 1 }) === null, 'eine fremde Taste gehoert nicht dem Raster');
});

test('Monatsraster: der Tab-Stopp bleibt nach dem Neuaufbau auf dem zuletzt fokussierten Tag', () => {
  withMonthState({}, () => {
    const dates = ['2026-08-31', '2026-09-01', '2026-09-24'];
    assert(calendarHelpers.monthRovingDate(dates, '2026-09-01') === '2026-09-24', 'ohne Fokusmerker: der Cursor');
    calendarHelpers.state.cursor = '2026-12-01';
    assert(calendarHelpers.monthRovingDate(dates, '2026-09-01') === '2026-09-01', 'Cursor nicht im Raster: der erste Monatstag');
  });
});

test('Woche und Tag: jeder Terminblock ist ein Knopf mit Namen wie die Agenda-Zeile', () => {
  const ev = { ...morningEvent(), location: 'Praxis Dr. Weber', cal_name: 'Familie' };
  const allDay = { id: 4133, title: 'Ausflug', all_day: 1, assigned_users: [], start_datetime: '2026-06-15T00:00', end_datetime: '2026-06-15T00:00' };
  withOvernightState({ events: [ev, allDay] }, () => {
    for (const [name, render] of [['Woche', calendarHelpers.renderWeekView], ['Tag', calendarHelpers.renderDayView]]) {
      const container = fakeContainer();
      render(container);
      const html = container.html;
      const block = new RegExp(`class="(?:week|day)-event[^"]*" data-id="4132"[^>]*>`).exec(html)?.[0] ?? '';
      assert(/role="button"/.test(block) && /tabindex="0"/.test(block), `${name}: der Zeitblock ist kein Knopf: ${block.slice(0, 120)}`);
      const aria = /aria-label="([^"]*)"/.exec(block)?.[1] ?? '';
      assert(aria.startsWith('Fruehstueck, ') && aria.includes('Praxis Dr. Weber') && aria.includes('Familie'),
        `${name}: der Name muss Titel, Zeit, Ort und Kalender tragen: ${aria}`);
      const chip = /class="allday-event" data-id="4133"[^>]*>/.exec(html)?.[0] ?? '';
      assert(/role="button"/.test(chip) && /tabindex="0"/.test(chip) && /aria-label="Ausflug, calendar.allDay/.test(chip),
        `${name}: der Ganztags-Balken ist kein benannter Knopf: ${chip.slice(0, 160)}`);
    }
  });
});

test('Woche: der Tageskopf ist ein Knopf in den Tag; Enter oeffnet Termin, Aufgabe und Tag', () => {
  withOvernightState({}, () => {
    const container = fakeContainer();
    calendarHelpers.renderWeekView(container);
    const headers = [...container.html.matchAll(/class="week-view__day-header" data-date="[^"]+" role="button" tabindex="0"\s+aria-label="calendar\.monthOpenDay/g)];
    assert(headers.length === 7, `alle sieben Tageskoepfe muessen benannte Knoepfe sein, gefunden ${headers.length}`);
  });
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  for (const [name, from, to] of [['Woche', 'function renderWeekView(', 'function chronological('], ['Tag', 'function renderDayView(', 'function renderDayEvent(']]) {
    const body = src.slice(src.indexOf(from), src.indexOf(to));
    assert(/addEventListener\('keydown', handleGridKeydown\)/.test(body), `${name}: Enter/Leertaste ist nicht verdrahtet`);
  }
  const handler = src.slice(src.indexOf('function handleGridKeydown('), src.indexOf('function scrollToHour('));
  for (const sel of ['.cal-task-chip', '.week-view__day-header', '.week-event, .day-event, .allday-event', 'view-schedule-entry']) {
    assert(handler.includes(sel), `handleGridKeydown kennt ${sel} nicht - der Tab-Stopp taete auf Enter nichts`);
  }
});

test('Woche und Tag: Tab laeuft in Uhrzeit-Reihenfolge, Schichten und Termine gemischt', () => {
  const order = calendarHelpers.chronological([
    { range: { start: 600, end: 660 }, html: () => 'C' },
    { range: { start: 480, end: 540 }, html: () => 'A' },
    { range: { start: 480, end: 600 }, html: () => 'B' },
  ]);
  assert(order === 'ABC', `erwartet A, B, C (Beginn, dann Ende) - gerendert ${order}`);
  const late = { ...morningEvent(), id: 4140, title: 'Spaet', start_datetime: '2026-06-15T18:00', end_datetime: '2026-06-15T19:00' };
  withOvernightState({ events: [late, morningEvent()] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    const ids = timedBlocks(container.html).map((b) => b.id);
    assert(JSON.stringify(ids) === JSON.stringify([4132, 4140]), `der fruehe Termin muss zuerst im DOM stehen: ${ids.join(', ')}`);
  });
});

test('Aufgabe im Kalender: der Name nennt die Prioritaet und die Uhrzeit, nicht nur den Titel', () => {
  const label = calendarHelpers.taskChipAriaLabel({ title: 'Steuer', priority: 'urgent', due_time: '14:30:00' });
  assert(label.includes('tasks.priorityLabel: tasks.priorityUrgent'), `die Prioritaet fehlt im Namen: ${label}`);
  assert(/14:30/.test(label), `die Uhrzeit fehlt im Namen: ${label}`);
  const none = calendarHelpers.taskChipAriaLabel({ title: 'Steuer', priority: 'none' });
  assert(!/priority/.test(none), `„ohne Prioritaet" sagt nichts, wie der Punkt: ${none}`);
  const html = calendarHelpers.renderTaskChip({ id: 1, title: 'Steuer', priority: 'high' });
  assert(/aria-label="calendar\.taskChipAriaLabel\{[^"]*\}, tasks\.priorityLabel: tasks\.priorityHigh"/.test(html),
    `der gerenderte Chip traegt die Prioritaet nicht im aria-label: ${html.slice(0, 200)}`);
});

test('Kopf: die Tablist heisst „Ansicht", die Knoepfe nennen ihre Kuerzel', () => {
  const html = calendarHelpers.toolbarHtml();
  assert(/role="tablist" aria-label="calendar\.viewSwitcher"/.test(html), 'die Tablist muss „Ansicht" heissen, nicht wie die H1');
  assert(!/role="tablist" aria-label="nav\.calendar"/.test(html), 'die Tablist heisst noch „Kalender"');
  for (const [view, key] of Object.entries({ month: 'm', week: 'w', day: 'd', agenda: 'a' })) {
    assert(new RegExp(`id="cal-view-tab-${view}"[^>]*aria-keyshortcuts="${key}"`).test(html), `Reiter ${view} nennt „${key}" nicht`);
  }
  const nav = calendarHelpers.periodNavHtml();
  assert(/id="cal-prev"[^>]*aria-keyshortcuts="k ArrowLeft"/.test(nav), 'zurueck nennt k und Pfeil links nicht');
  assert(/id="cal-next"[^>]*aria-keyshortcuts="j ArrowRight"/.test(nav), 'vor nennt j und Pfeil rechts nicht');
  assert(/id="cal-today"[^>]*aria-keyshortcuts="t"/.test(nav), 'heute nennt t nicht');
  assert(calendarHelpers.periodArrowKeys(true).prev === 'ArrowRight', 'RTL: zurueck ist Pfeil rechts');
});

test('Kuerzel: t, j/k und m/w/d/a gelten nur auf /calendar und gehen an die Seite, nicht an den DOM', () => {
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const { CAL_SHORTCUT_KEYS } = calendarHelpers;
  const keys = [CAL_SHORTCUT_KEYS.today, CAL_SHORTCUT_KEYS.prev, CAL_SHORTCUT_KEYS.next, ...Object.values(CAL_SHORTCUT_KEYS.views)];
  for (const key of keys) {
    assert(new RegExp(`\\{ key: '${key}', route: '/calendar'`).test(router), `SHORTCUTS fuehrt „${key}" nicht als Kalender-Kuerzel`);
  }
  const dispatch = router.slice(router.indexOf('function initKeyboardShortcuts('), router.indexOf('function showHelpModal('));
  assert(/shortcutApplies\(s\)/.test(dispatch), 'der Dispatcher prueft die Route eines Kuerzels nicht - „d" schaltete ueberall');
  assert(/bareFocusOnly/.test(dispatch) && /focusIsBare\(\)/.test(dispatch),
    'die Pfeile duerfen nur ohne Fokus auf einem Bedienelement blaettern (Raster, Tablist, Felder)');
  // Der Akkord „g d" wird VOR der Einzeltaste entschieden.
  assert(dispatch.indexOf("_pendingKey === 'g'") < dispatch.indexOf('shortcutApplies(s)'), 'der g-Akkord muss vor den Einzeltasten stehen');
  const help = router.slice(router.indexOf('function showHelpModal('));
  assert(/SHORTCUTS\.filter\(\(s\) => shortcutApplies\(s\)\)/.test(help), 'die Hilfe zeigt Kuerzel, die hier nichts tun');
  const cal = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert(/addEventListener\?\.\('yuvomi:calendar-command', onCalendarCommand\)/.test(cal), 'die Seite hoert die Kuerzel nicht');
});

/* PR #1460, Review: der Tipp auf einen Tag zeichnet das Raster bewusst NICHT
 * neu - also muss selectMonthDay() den einen Tab-Stopp selbst mitnehmen, sonst
 * landet Tab von aussen auf dem alten Tag und die Pfeile starten dort. */
test('Telefon-Monat: der Tipp auf einen Tag nimmt den Tab-Stopp mit', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const sel = src.slice(src.indexOf('function selectMonthDay('), src.indexOf('let _monthFocusDate'));
  assert(/cell\.tabIndex\s*=\s*selected\s*\?\s*0\s*:\s*-1/.test(sel),
    'selectMonthDay() muss tabindex 0 auf den gewaehlten Tag und -1 auf alle anderen setzen');
  assert(!/\.focus\(/.test(sel), 'ein Tipp darf den Fokus nicht verschieben');
});

/* CONTRIBUTING.md: „Pages export a render() function, no side effects on
 * import". Die beiden Listener dieser Seite (Kuerzel, 640er-Schwelle) haengen
 * sich deshalb erst im ersten render() an - einmal, nicht je Besuch. */
const importListeners = await (async () => {
  const zuvor = { window: globalThis.window, document: globalThis.document };
  const angehaengt = [];
  try {
    globalThis.document = { addEventListener: (type) => angehaengt.push(`document:${type}`) };
    globalThis.window = { matchMedia: () => ({ matches: false, addEventListener: (type) => angehaengt.push(`matchMedia:${type}`) }) };
    await import(`../public/pages/calendar.js?import-probe=${Date.now()}`);
  } finally {
    globalThis.window = zuvor.window;
    globalThis.document = zuvor.document;
  }
  return angehaengt;
})();
test('Kalender-Seite: der Import haengt keine Listener an', () => {
  assert(importListeners.length === 0, `der Import haengt an: ${importListeners.join(', ')}`);
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const page = src.slice(src.indexOf('export async function render('), src.indexOf('// Lade-Skeleton sofort'));
  assert(/bindPageListeners\(\)/.test(page), 'render() muss die Listener der Seite anhaengen');
});

test('Telefon-Monat: die Auswahl wird angesagt - aus einer Live-Region, die den Neuaufbau ueberlebt', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const page = src.slice(src.indexOf('export async function render('), src.indexOf('// Lade-Skeleton sofort'));
  assert(/id="cal-live"[^>]*aria-live="polite"/.test(page), 'die Seite hat keine polite Live-Region');
  assert(page.indexOf('id="cal-live"') < page.indexOf('id="cal-body"') || !/id="cal-body"[\s\S]*id="cal-live"/.test(page),
    'die Live-Region muss AUSSERHALB von #cal-body stehen, sonst entsteht sie mit ihrem Inhalt');
  const sel = src.slice(src.indexOf('function selectMonthDay('), src.indexOf('let _monthFocusDate'));
  assert(/announceMonthDay\(date\)/.test(sel), 'die Auswahl eines Tages wird nicht angesagt');
  const view = src.slice(src.indexOf('function renderView('), src.indexOf('function syncHeadToScrollport('));
  assert(!/announceMonthDay/.test(view), 'renderView() darf nicht ansagen - sonst redet jeder Filterwechsel');
});

test('Aufgaben-Chip: Trefferflaeche in der Liste auf --target-base, im Ganztags-Stapel mindestens 24px', () => {
  const css = readFileSync(new URL('../public/styles/calendar.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const before = rules.find((r) => r.selector.trim() === '.agenda-tasks .cal-task-chip::before');
  assert(before && /inset-block:\s*calc\(-1 \* var\(--task-hit-grow\)\)/.test(before.body), 'die Liste dehnt die Aufgabe nicht per ::before');
  const list = rules.find((r) => r.selector.trim() === '.agenda-tasks');
  assert(list && /--task-hit-grow:\s*calc\(\(var\(--target-base\) - var\(--space-6\)\) \/ 2\)/.test(list.body),
    'die Dehnung muss aus --target-base kommen');
  // Seit 2026-09-24 duerfen sich die Dehnungen zweier Aufgaben ueberlappen
  // (8px Zeilenabstand statt 20-24px) - aber nur UNTER den Chips: die sichtbare
  // Bar trifft immer sich selbst.
  assert(/row-gap:\s*var\(--space-2\)/.test(list.body), 'der Zeilenabstand der Aufgaben ist wieder die doppelte Dehnung (48px-Takt)');
  assert(/isolation:\s*isolate/.test(list.body) && /z-index:\s*-1/.test(before.body),
    'ueberlappende Dehnungen muessen unter den Chips liegen, sonst trifft ein Tipp auf die untere Bar die obere Aufgabe');
  const chip = rules.find((r) => r.selector.trim() === '.agenda-tasks .cal-task-chip');
  assert(chip && /overflow:\s*visible/.test(chip.body), 'der Chip schneidet sein eigenes ::before ab (overflow)');
  const stack = rules.find((r) => r.selector.trim() === '.allday-cell .cal-task-chip');
  assert(stack && /min-height:\s*var\(--space-6\)/.test(stack.body), 'im Ganztags-Stapel bleibt die Aufgabe unter 24px');
  const focus = rules.find((r) => /\.week-event:focus-visible/.test(r.selector) && /\.day-event:focus-visible/.test(r.selector));
  assert(focus && /outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/.test(focus.body), 'Terminbloecke haben keinen Fokusring');
});

// --------------------------------------------------------
// EIN ZEITFORMAT (Critique 2026-09-24, P2). Drei Schreibweisen derselben
// Spanne standen im Kalender: Raster ohne Leerzeichen mit Gedankenstrich,
// Agenda mit Gedankenstrich und „Uhr", Detail „10:00 Uhr - 11:30 Uhr". Jetzt
// eine: `calendar.dayRangeLabel` („{{from}} - {{to}}") ueber formatTime(), das
// Suffix einmal am Ende - im Raster ohne, sonst mit.
// --------------------------------------------------------
test('timeSpanText: Spanne ueber den Locale-Trenner, Suffix einmal am Ende', () => {
  globalThis.__timeSuffix = 'Uhr';
  try {
    const span = calendarHelpers.timeSpanText('2026-09-24T17:00', '2026-09-24T18:30');
    assert(span === 'calendar.dayRangeLabel{"from":"2026-09-24T17:00","to":"2026-09-24T18:30"} Uhr',
      `erwartet Trenner aus der Locale und ein Suffix am Ende: ${span}`);
    const grid = calendarHelpers.timeSpanText('2026-09-24T17:00', '2026-09-24T18:30', { suffix: false });
    assert(!grid.includes('Uhr'), `die Rasterfassung traegt kein Suffix: ${grid}`);
    const open = calendarHelpers.timeSpanText('2026-09-24T17:00', null);
    assert(open === '2026-09-24T17:00 Uhr', `ohne Ende nur der Start mit Suffix: ${open}`);
  } finally {
    delete globalThis.__timeSuffix;
  }
});

test('Zeitformat: Raster, Liste, gesprochener Name und Schicht gehen durch denselben Helfer', () => {
  globalThis.__timeSuffix = 'Uhr';
  try {
    const ev = glyphEvent({});
    const range = 'calendar.dayRangeLabel{"from":"2026-09-24T09:00","to":"2026-09-24T10:30"}';
    const html = {};
    withMonthState({ events: [ev] }, () => {
      html.week = calendarHelpers.renderWeekEvent(ev, null, '2026-09-24');
      html.day = calendarHelpers.renderDayEvent(ev, null, '2026-09-24');
      html.agenda = calendarHelpers.renderAgendaEvent(ev, '2026-09-24');
    });
    const esc = (text) => escStub(text);
    assert(html.week.includes(`class="week-event__when">${range}<`), `Woche: Rasterfassung erwartet: ${html.week}`);
    assert(html.day.includes(`class="day-event__meta">${range}<`), `Tag: Rasterfassung erwartet: ${html.day}`);
    assert(html.agenda.includes(`<span>${esc(`${range} Uhr`)}</span>`), `Agenda: Listenfassung mit Suffix erwartet: ${html.agenda}`);
    for (const [view, markup] of Object.entries(html)) {
      assert(markup.includes(esc(`Zahnarzt, ${range} Uhr`)),
        `${view}: der gesprochene Name nennt die Zeit in der Listenfassung - ein Termin klingt ueberall gleich`);
    }
    const shift = calendarHelpers.scheduleTimeLabel({ start_time: '22:00', end_time: '06:00' });
    assert(shift === 'calendar.dayRangeLabel{"from":"22:00","to":"06:00"} Uhr +1',
      `die Schichtspanne geht durch formatTime() (12 Stunden!) und denselben Trenner: ${shift}`);
  } finally {
    delete globalThis.__timeSuffix;
  }
});

test('calendar.js enthaelt keinen Gedankenstrich - weder im UI-Text noch im Kommentar', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const hits = src.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /[\u2013\u2014]/.test(line));
  assert(hits.length === 0,
    `Projektregel: "-" statt Em-/En-Dash (CLAUDE.md). Fundstellen: ${hits.map(([n]) => n).join(', ')}`);
  for (const file of readdirSync(new URL('../public/locales/', import.meta.url)).filter((n) => n.endsWith('.json'))) {
    const range = JSON.parse(readFileSync(new URL(`../public/locales/${file}`, import.meta.url), 'utf8')).calendar.dayRangeLabel;
    assert(!/[\u2013\u2014]/.test(range), `${file}: calendar.dayRangeLabel traegt einen Gedankenstrich: ${range}`);
  }
});

// --------------------------------------------------------
// EINE BLOCKGRAMMATIK (Critique 2026-09-24, P2): Monat, Woche, Tag, Ganztag und
// die Listenzeile nennen die Terminfarbe mit derselben Kante, die Bloecke mit
// demselben Ink-Rezept. Vorher: Tag mit eigenem Spine-Element NEBEN der Kante
// (zwei Striche), Woche 38 % statt 35 %, Liste mit 8px-Punkt, Icons im Vollton.
// --------------------------------------------------------
test('Blockgrammatik: eine Kante, ein Ink-Rezept, Titel oben, Glyphen in der Tinte', () => {
  const rules = [...eachRule(calendarCss)];
  const body = (selector) => rules.filter((r) => r.selector.trim() === selector).map((r) => r.body).join(';');
  for (const selector of ['.month-day__event', '.week-event', '.day-event', '.allday-event', '.agenda-event__body']) {
    assert(/border-inline-start:\s*var\(--cal-event-edge\) solid var\(--ev-color/.test(body(selector)),
      `${selector}: die Terminfarbe steht nicht als Kante aus --cal-event-edge`);
  }
  const inks = ['.month-day__event', '.week-event', '.day-event', '.allday-event']
    .map((selector) => body(selector).match(/(?:^|;)\s*color:\s*color-mix\(in srgb, var\(--ev-color\) (\d+)%/)?.[1]);
  assert(new Set(inks).size === 1 && inks[0] === '35', `ein Ink-Rezept fuer alle Bloecke erwartet, gefunden: ${inks.join(', ')}`);
  assert(!/(?:^|;)\s*border:/.test(body('.week-event') + body('.allday-event')),
    'Woche und Ganztag tragen wieder einen Rahmen, den Monat und Tag nicht haben');
  assert(!rules.some((r) => /day-event__spine/.test(r.selector)), 'das zweite Kanten-Element des Tags ist zurueck');
  assert(!/day-event__spine/.test(readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8')),
    'renderDayEvent zeichnet wieder ein eigenes Spine-Element');
  assert(/align-items:\s*flex-start/.test(body('.day-event')), 'der Tagesblock zentriert seinen Titel wieder senkrecht');
  assert(!rules.some((r) => /event-icon/.test(r.selector) && /(?:^|;)\s*color:\s*var\(--ev-color\)/.test(r.body)),
    'ein Terminicon steht wieder im Vollton der Nutzerfarbe statt in der Tinte');
  assert(!rules.some((r) => r.selector.trim() === '.agenda-event__color'), 'der Farbpunkt der Listenzeile ist zurueck');
});

test('Blockgrammatik: die Zeitzeile erscheint nach der Hoehe des Blocks, nicht halb abgeschnitten', () => {
  assert(/container:\s*ev-block \/ size/.test(calendarCss.slice(calendarCss.indexOf('\n.week-event {'))),
    'der Wochenblock ist kein Groessen-Container');
  const query = /@container ev-block \(height < ([\d.]+)rem\)\s*\{([^}]*)\}/.exec(calendarCss);
  assert(query && /\.week-event__time/.test(query[2]) && /\.day-event__meta/.test(query[2]),
    'Woche und Tag muessen ihre Zeitzeile ueber dieselbe Hoehenfrage ausblenden');
});

// DER TITEL VOR DEM „WER" (Re-Kritik 2026-09-25, P2). Im Wochenblock standen
// die Zugewiesenen in der Titelzeile und schrumpften nie: mobil blieben von
// „Zahnarzt - Familie" 44 von 112px, am Desktop vom Ganztagsbalken
// „Städtereise übers Wochenende" 73 von 181px. Gemessen im Browser (Uebergabe);
// hier steht, was die Messung traegt.
test('Blockgrammatik: die Zugewiesenen stehen in der Zeitzeile, nie in der Titelzeile', () => {
  const ev = glyphEvent({ assigned_users: [{ id: 1, display_name: 'Linda' }, { id: 2, display_name: 'Leo' }] });
  let html = '';
  withMonthState({ events: [ev] }, () => { html = calendarHelpers.renderWeekEvent(ev, null, '2026-09-24'); });
  const title = /<div class="week-event__title">([\s\S]*?)<\/div>/.exec(html);
  assert(title && !title[1].includes('cal-chip__assigned'), `die Titelzeile gehoert dem Titel: ${html}`);
  const time = /<div class="week-event__time"><span class="week-event__when">[^<]*<\/span>(<span class="cal-chip__assigned">)/.exec(html);
  assert(time, `die Zugewiesenen stehen HINTER der Uhrzeit in der Zeitzeile: ${html}`);
  assert(/title="[^"]*Linda, Leo/.test(html), 'das „Wer" bleibt im title-Attribut');

  // Die Zeitzeile bricht um und schneidet ab: passt der Stack nicht neben die
  // Uhrzeit, faellt er als Ganzes in die unsichtbare zweite Zeile. Die
  // Hoehenfrage (ev-block) blendet ihn mit der Zeitzeile aus.
  const rule = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.week-event__time');
  assert(rule && /display:\s*flex/.test(rule.body) && /flex-wrap:\s*wrap/.test(rule.body),
    `die Zeitzeile muss umbrechen: ${rule?.body}`);
  assert(/(?:^|[\s;])height:\s*1lh/.test(rule.body) && /overflow:\s*hidden/.test(rule.body),
    `die Zeitzeile ist eine Zeilenhoehe hoch und schneidet Zeile zwei ab: ${rule.body}`);
});

test('Ganztags-Chip: die Zugewiesenen erscheinen nur neben dem GANZEN Label (Re-Kritik 2026-09-25)', () => {
  const ev = longTimedEvent({ assigned_users: [{ id: 1, display_name: 'Linda' }] });
  let html = '';
  withOvernightState({ cursor: '2026-06-14', events: [ev] }, () => {
    const container = fakeContainer();
    calendarHelpers.renderDayView(container);
    html = container.html;
  });
  assert(/<span class="allday-event__line"><span class="allday-event__label">[\s\S]*?<\/span><span class="cal-chip__assigned">/.test(html),
    `Label und Zugewiesene teilen sich EINE umbrechende Zeile, der Stack hinter dem Label: ${html}`);
  const regeln = [...eachRule(calendarCss)];
  const zeile = regeln.find((r) => r.selector.trim() === '.allday-event__line');
  assert(zeile && /flex-wrap:\s*wrap/.test(zeile.body) && /(?:^|[\s;])height:\s*1lh/.test(zeile.body)
    && /overflow:\s*hidden/.test(zeile.body), `die Zeile muss umbrechen und Zeile zwei abschneiden: ${zeile?.body}`);
  // Das Label bricht mit seiner VOLLEN Breite um. Mit Basis 0 waere seine
  // hypothetische Groesse null, der Stack passte immer daneben und naehme dem
  // Titel wieder den Platz.
  const label = regeln.find((r) => r.selector.trim() === '.allday-event__label');
  assert(/flex:\s*0\s+1\s+auto/.test(label.body), `das Label bricht mit seiner vollen Breite um: ${label.body}`);
});

test('Ganztags-Beschriftung bricht um, statt aus der 44px-Spalte zu ragen', () => {
  const label = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.calendar-all-day-label');
  assert(/overflow-wrap:\s*anywhere/.test(label.body), 'ein Wort ohne Bruchstelle ragt wieder aus der Spalte');
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8')).calendar.allDayShort;
  assert(de.includes('\u00ad'), `„ganztg." war 42,5px breit in 44px - das deutsche Wort braucht eine Trennstelle: ${de}`);
});

// --------------------------------------------------------
// Termin-Dialog: Reihenfolge, Aufklapper, Hinweiszeilen (Critique 2026-09-24, P2)
// --------------------------------------------------------

/**
 * Rendert den Dialog wie im Browser und haelt fest, was `advancedSection()`
 * bekommt: der Loader stubt modal.js, der Aufklapper waere sonst unsichtbar.
 */
function renderEventDialog({ mode = 'create', event = null, users = [{ id: 1, display_name: 'Anna Berg' }, { id: 2, display_name: 'Ben Berg' }] } = {}) {
  const vorher = { users: calendarHelpers.state.users, hook: globalThis.__advancedSection, ms: globalThis.__renderUserMultiSelect };
  let advanced = null;
  globalThis.__renderUserMultiSelect = (_people, _ids, name) => `<div class="user-ms" data-ms-name="${name}"></div>`;
  globalThis.__advancedSection = (inner, opts) => {
    advanced = { inner: String(inner), opts };
    return `<details class="form-advanced"${opts?.open ? ' open' : ''}><summary class="form-advanced__summary"></summary><div class="form-advanced__body">${inner}</div></details>`;
  };
  calendarHelpers.state.users = users;
  try {
    const html = calendarHelpers.buildEventModalContent({ mode, event, date: '2030-05-01', reminder: [] });
    return { html, advanced };
  } finally {
    calendarHelpers.state.users = vorher.users;
    if (vorher.hook === undefined) delete globalThis.__advancedSection;
    else globalThis.__advancedSection = vorher.hook;
    if (vorher.ms === undefined) delete globalThis.__renderUserMultiSelect;
    else globalThis.__renderUserMultiSelect = vorher.ms;
  }
}

const EDIT_BASE = {
  id: 9, title: 'Elternabend', start_datetime: '2030-05-01T19:00', end_datetime: '2030-05-01T20:30',
  visibility: 'all', created_by: 1,
};

test('Termin-Dialog: die Felder stehen nach Haeufigkeit, Seltenes hinter „Weitere Einstellungen"', () => {
  const { html, advanced } = renderEventDialog();
  assert(advanced, 'der Dialog baut „Weitere Einstellungen" nicht mehr ueber advancedSection()');
  // Titel, Wann, Wer, Wiederholung, Erinnerung, Ort, Beschreibung - dann der Aufklapper.
  const main = ['id="modal-title"', 'id="modal-allday"', 'id="modal-start-date"', 'data-ms-name="cal_assigned"',
    'id="modal-reminder-toggle"', 'id="modal-location"', 'id="modal-description"',
    '<details class="form-advanced"'];
  const at = main.map((m) => html.indexOf(m));
  assert(at.every((i) => i >= 0), `nicht gerendert: ${main.filter((_, i) => at[i] < 0).join(', ')}`);
  assert(at.every((i, k) => k === 0 || at[k - 1] < i),
    `Reihenfolge ist ${main.slice().sort((a, b) => html.indexOf(a) - html.indexOf(b)).join(' < ')}`);
  for (const m of main.slice(0, -1)) {
    assert(!advanced.inner.includes(m), `${m} steht hinter dem Aufklapper - es gehoert in den Hauptteil`);
  }
  // Die Wiederholung rendert der Loader als Stub (''), ihre Stelle steht im
  // Aufruf: zwischen der Personenwahl und der Erinnerung, ausserhalb des
  // Aufklappers.
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function buildEventModalContent('), src.indexOf('\nfunction confirmCalendarOverrideOrphans('));
  const ret = body.slice(body.indexOf('return `'));
  const [who, rrule, remind] = ["renderUserMultiSelect(", "renderRRuleFields('event'", 'renderCalendarReminderSection('].map((m) => ret.indexOf(m));
  assert(who > 0 && who < rrule && rrule < remind, `Wiederholung steht nicht zwischen Wer und Erinnerung (${who}/${rrule}/${remind})`);
  // Sichtbarkeit, Stichtag, Farbe, Icon, Sync-Ziel, Anhang - in dieser Folge.
  const rare = ['id="modal-visibility"', 'id="modal-countdown"', 'id="event-color-picker"', 'id="modal-icon-trigger"',
    'id="event-sync-target"', 'id="modal-attachment"'];
  const inner = rare.map((m) => advanced.inner.indexOf(m));
  assert(inner.every((i) => i >= 0), `nicht hinter dem Aufklapper: ${rare.filter((_, i) => inner[i] < 0).join(', ')}`);
  assert(inner.every((i, k) => k === 0 || inner[k - 1] < i), 'die seltenen Felder stehen in anderer Folge');
  // Der Aufklapper nennt, was hinter ihm liegt - aus den Beschriftungen der Felder.
  assert(advanced.opts?.hint === calendarHelpers.eventAdvancedTopics({ visibilityOffered: true, attachment: true }),
    `der Aufklapper nennt seinen Inhalt nicht: ${JSON.stringify(advanced.opts)}`);
  for (const key of ['common.visibility.label', 'calendar.colorLabel', 'calendar.iconLabel', 'calendar.syncTargetLabel', 'calendar.attachmentLabel']) {
    assert(advanced.inner.includes(key), `${key} steht in der Zeile des Aufklappers, aber kein Feld dahinter traegt es`);
  }
  assert(advanced.opts.open === false, 'ein neuer Termin oeffnet „Weitere Einstellungen"');
});

test('Termin-Dialog: der Aufklapper nennt nur, was er zeigt', () => {
  const alle = calendarHelpers.eventAdvancedTopics({ visibilityOffered: true, attachment: true });
  const ohne = calendarHelpers.eventAdvancedTopics({ visibilityOffered: false, attachment: false });
  assert(alle.includes('common.visibility.label') && alle.includes('calendar.attachmentLabel'), alle);
  assert(!ohne.includes('common.visibility.label'), `Sichtbarkeit genannt, obwohl das Feld verborgen ist: ${ohne}`);
  assert(!ohne.includes('calendar.attachmentLabel'), `Anhang genannt ohne Dokumente-Zugriff: ${ohne}`);
  assert(ohne.includes('dashboard.countdownTitle'), 'der Stichtag fehlt in der Zeile - genau ihn faende sonst niemand (#647)');
  // Der Aufrufer liest dieselbe Bedingung wie das Feld: ein Haushalt ohne weitere Leser.
  const solo = renderEventDialog({ users: [{ id: 1, display_name: 'Anna Berg' }] });
  assert(!solo.advanced.opts.hint.includes('common.visibility.label'),
    `im Haushalt ohne weitere Leser nennt der Aufklapper eine verborgene Sichtbarkeit: ${solo.advanced.opts.hint}`);
});

test('Termin-Dialog: beim Bearbeiten geht der Aufklapper nur fuer Unsichtbares auf', () => {
  const open = (event) => renderEventDialog({ mode: 'edit', event: { ...EDIT_BASE, ...event } }).advanced.opts.open;
  assert(open({}) === false, 'ein schlichter Termin oeffnet „Weitere Einstellungen"');
  assert(open({ color: '#3B82F6', icon: 'star' }) === false, 'Farbe und Icon zeigt der Termin selbst - kein Grund aufzuklappen');
  assert(open({ description: 'Mitbringen: Stifte' }) === false, 'die Beschreibung steht im Hauptteil und oeffnet nichts mehr');
  assert(open({ countdown: 1 }) === true, 'ein Stichtag bleibt zugeklappt versteckt');
  assert(open({ visibility: 'private' }) === true, 'eine eingeschraenkte Sichtbarkeit bleibt zugeklappt versteckt');
  assert(open({ attachment_document_id: 3, attachment_name: 'a.pdf' }) === true, 'ein Anhang bleibt zugeklappt versteckt');
  const solo = renderEventDialog({ mode: 'edit', event: { ...EDIT_BASE, visibility: 'private' }, users: [{ id: 1, display_name: 'Anna Berg' }] });
  assert(solo.advanced.opts.open === false, 'fuer ein verborgenes Sichtbarkeitsfeld klappt der Dialog auf');
});

test('Termin-Dialog: Von und Bis sind je eine Zeile, jedes Feld behaelt seinen Namen', () => {
  const { html } = renderEventDialog();
  const row = /<div class="cal-when" id="time-fields">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const labels = [...row.matchAll(/<label[^>]*for="([\w-]+)"[^>]*>([^<]*)<\/label>/g)].map((m) => `${m[1]}=${m[2]}`);
  assert(JSON.stringify(labels) === JSON.stringify(['modal-start-date=calendar.fromLabel', 'modal-end-date=calendar.toLabel']),
    `Zeilenbeschriftungen: ${labels.join(', ')}`);
  // Das Datum heisst wie seine Zeile (sichtbarer Name im zugaenglichen), die
  // Uhrzeit bringt ihren eigenen mit - sie hat keine sichtbare Beschriftung.
  assert(!/id="modal-start-date"[^>]*\blabel="/.test(row), 'das Datumsfeld ueberschreibt die sichtbare Zeilenbeschriftung „Von"');
  assert(/id="modal-start-time"[^>]*\blabel="calendar\.startTimeLabel"/.test(row), 'das Zeitfeld hat keinen eigenen Namen');
  assert(/id="modal-end-time"[^>]*\blabel="calendar\.endTimeLabel"/.test(row), 'das Endzeitfeld hat keinen eigenen Namen');
  const grid = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.cal-when');
  assert(grid && /grid-template-columns:\s*max-content\b/.test(grid.body),
    'die Beschriftungsspalte ist nicht mehr EINE Spalte fuer beide Zeilen');
});

test('Termin-Dialog: die Sichtbarkeitswarnung klappt ihren Abschnitt auf', () => {
  // Die Sichtbarkeit steht hinter „Weitere Einstellungen". Wer oben die letzte
  // Person abwaehlt, waehrend „Nur Zugewiesene" gilt, bekaeme die Warnung sonst
  // in einem geschlossenen <details>.
  const listeners = {};
  const details = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const select = { value: 'assignees', addEventListener: (type, fn) => { listeners.select = fn; } };
  const warn = { hidden: true, closest: (sel) => (sel === 'details' ? details : null) };
  const ms = { addEventListener: (type, fn) => { listeners.ms = fn; } };
  const panel = { querySelector: (sel) => ({ '#vis': select, '#warn': warn, '.user-ms[data-ms-name="cal_assigned"]': ms })[sel] ?? null };
  const vorher = globalThis.__getSelectedUserIds;
  globalThis.__getSelectedUserIds = () => [1];
  try {
    calendarHelpers.wireVisibilityWarning(panel, '#vis', 'cal_assigned', '#warn');
    assert(warn.hidden === true && !('open' in details.attrs), 'mit einer Person gibt es nichts zu warnen und nichts aufzuklappen');
    globalThis.__getSelectedUserIds = () => [];
    listeners.select();
    assert(warn.hidden === false, 'ohne Person bei „Nur Zugewiesene" fehlt die Warnung');
    assert(details.attrs.open === '', 'die Warnung steht in einem geschlossenen Abschnitt');
  } finally {
    if (vorher === undefined) delete globalThis.__getSelectedUserIds;
    else globalThis.__getSelectedUserIds = vorher;
  }
});

/*
 * JEDE KLASSE IM TERMIN-DIALOG HAT EINE REGEL IN EINEM BLATT, DAS /calendar
 * LAEDT. `.form-hint` lebte in settings.css, der Router laedt pro Route genau
 * ein Seiten-Blatt - im Dialog standen sieben Hinweise in 16px Primaertinte,
 * und `.form-help` (Anhang) hatte nirgends eine Regel. Geprueft wird das
 * gerenderte Markup gegen die Blaetter, die auf /calendar wirklich geladen
 * sind: index.html, calendar.css und reminders.css (router.js laedt es fuer
 * jede angemeldete Sitzung).
 */
test('Termin-Dialog: jede Klasse im Markup hat eine Regel in einem Blatt, das /calendar laedt', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const sheets = [...read('../public/index.html').matchAll(/<link rel="stylesheet" href="\/styles\/([\w-]+\.css)"/g)]
    .map((m) => m[1]).concat('calendar.css', 'reminders.css');
  const styled = new Set();
  for (const file of sheets) {
    for (const { selector } of eachRule(read(`../public/styles/${file}`))) {
      for (const m of selector.matchAll(/\.([\w-]+)/g)) styled.add(m[1]);
    }
  }
  // Klassen, die KEINE Regel brauchen - mit Grund, nicht als Sammelbecken.
  const HOOKS = new Map([
    ['event-icon-picker__trigger-icon', 'traegt das Icon; gestaltet ueber `.event-icon-picker__trigger svg`'],
  ]);
  const event = {
    ...EDIT_BASE, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', countdown: 1, visibility: 'assignees',
    attachment_document_id: 3, attachment_name: 'a.pdf', attachment_mime: 'application/pdf',
  };
  const unstyled = new Set();
  for (const { html } of [renderEventDialog(), renderEventDialog({ mode: 'edit', event })]) {
    for (const m of html.matchAll(/class="([^"$]*)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        if (!cls.startsWith('js-') && !styled.has(cls) && !HOOKS.has(cls)) unstyled.add(cls);
      }
    }
  }
  assert(unstyled.size === 0, `ohne Regel auf /calendar (faellt auf den Koerpertext zurueck): ${[...unstyled].join(', ')}`);
});

// --------------------------------------------------------
// MEHRTAEGIGE TERMINE ALS BAENDER (Re-Kritik 2026-09-25, P2)
//
// „Städtereise" 13.-15.10. stand im Monat als drei gleiche Chips und in der
// Woche als drei Chips a 128px; der Screenreader hoerte dreimal „Ganztaegig".
// Jetzt: EIN Band je Wochenzeile, gepackt in Spuren (packLanes aus
// utils/week-strip.js, dieselbe Packung wie die Uebersichtskachel), mit
// offenem Ende, wo der Termin ueber die Zeile hinauslaeuft.
// --------------------------------------------------------
const { packLanes } = await import('../public/utils/week-strip.js');
const bandDays = (from, n = 7) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});
const bandEvent = (id, start, end, extra = {}) => ({
  id, title: `T${id}`, all_day: 1, assigned_users: [],
  start_datetime: `${start}T00:00`, end_datetime: `${end}T00:00`, ...extra,
});
function segmentsFor(events, days) {
  const byDay = (day) => events.filter((ev) => ev.start_datetime.slice(0, 10) <= day
    && calendarHelpers.eventEndDate(ev) >= day);
  return calendarHelpers.bandSegments(days, byDay);
}

test('packLanes: ueberlappende Spannen bekommen verschiedene Spuren, eine freie Spur wird wiederverwendet', () => {
  const { lanes, laneCount } = packLanes([
    { first: 1, last: 3 }, { first: 3, last: 5 }, { first: 4, last: 6 }, { first: 6, last: 6 },
  ]);
  assert(JSON.stringify(lanes) === '[0,1,0,1]', `Spuren erwartet [0,1,0,1]: ${JSON.stringify(lanes)}`);
  assert(laneCount === 2, `zwei Spuren reichen: ${laneCount}`);
  const capped = packLanes([{ first: 0, last: 2 }, { first: 1, last: 1 }, { first: 1, last: 3 }], { maxLanes: 2 });
  assert(JSON.stringify(capped.lanes) === '[0,1,-1]', `ueber dem Deckel -1: ${JSON.stringify(capped.lanes)}`);
});

test('Baender: Spurvergabe nach echtem Anfang und Laenge, ueberlappend in verschiedenen Spuren', () => {
  // Woche Mo 26.10. - So 01.11.2026. A 27.-29., B 29.-31. (ueberlappt A am
  // 29.), C 30.10.-02.11. (beginnt nach A: Spur von A wieder frei), D ein
  // einzelner Ganztag (kein Band).
  const days = bandDays('2026-10-26');
  const events = [
    bandEvent(1, '2026-10-27', '2026-10-29'),
    bandEvent(2, '2026-10-29', '2026-10-31'),
    bandEvent(3, '2026-10-30', '2026-11-02'),
    bandEvent(4, '2026-10-28', '2026-10-28'),
  ];
  const { bands, laneCount, depth, events: bandSet } = segmentsFor(events, days);
  const lane = Object.fromEntries(bands.map((b) => [b.ev.id, b.lane]));
  assert(bands.length === 3, `drei Baender, der Eintagestermin ist keins: ${bands.map((b) => b.ev.id)}`);
  assert(!bandSet.has(events[3]), 'ein eintaegiger Ganztag bleibt ein Chip in seiner Zelle');
  assert(lane[1] === 0 && lane[2] === 1 && lane[3] === 0, `Spuren A0 B1 C0 erwartet: ${JSON.stringify(lane)}`);
  assert(laneCount === 2, `zwei Spuren: ${laneCount}`);
  assert(JSON.stringify(depth) === '[0,1,1,2,2,2,1]', `belegte Spuren je Tag: ${JSON.stringify(depth)}`);
  // Stabil: zwei Termine mit gleichem Anfang - der laengere zuerst.
  const same = segmentsFor([bandEvent(5, '2026-10-27', '2026-10-28'), bandEvent(6, '2026-10-27', '2026-10-30')], days);
  const sameLane = Object.fromEntries(same.bands.map((b) => [b.ev.id, b.lane]));
  assert(sameLane[6] === 0 && sameLane[5] === 1, `gleicher Anfang: der laengere in Spur 0: ${JSON.stringify(sameLane)}`);
});

test('Baender: Wochenumbruch - offene Enden an Zeilengrenze, Kante nur am echten Anfang', () => {
  const ev = bandEvent(7, '2026-10-30', '2026-11-02');
  const first = segmentsFor([ev], bandDays('2026-10-26')).bands[0];
  const second = segmentsFor([ev], bandDays('2026-11-02')).bands[0];
  assert(first.first === 4 && first.last === 6, `Woche 1: Fr bis So: ${first.first}-${first.last}`);
  assert(!first.continuesBefore && first.continuesAfter, 'Woche 1: echter Anfang, offenes Ende');
  assert(second.first === 0 && second.last === 0, `Woche 2: nur der Montag: ${second.first}-${second.last}`);
  assert(second.continuesBefore && !second.continuesAfter, 'Woche 2: Fortsetzung, echtes Ende');

  // Am gerenderten Band: die Klassen, die Kante und Rundung oeffnen, und das
  // Fortsetzungszeichen - Monat und Woche aus denselben Segmenten.
  const month1 = calendarHelpers.monthBandsHtml({ bands: [first] });
  const month2 = calendarHelpers.monthBandsHtml({ bands: [second] });
  assert(/class="month-day__event cal-band cal-band--after"/.test(month1) && !/cal-band--before/.test(month1),
    `Monat Woche 1: nur das Ende offen: ${month1}`);
  assert(/class="month-day__event cal-band cal-band--before"/.test(month2) && !/cal-band--after/.test(month2),
    `Monat Woche 2: nur der Anfang offen: ${month2}`);
  assert(/cal-band__cont--after/.test(month1) && /cal-band__cont--before/.test(month2), 'das Fortsetzungszeichen steht am offenen Ende');
  assert(/grid-column:5 \/ span 3/.test(month1) && /grid-column:1 \/ span 1/.test(month2), 'Spalten aus den Segmenten');
  const week = calendarHelpers.renderWeekBand(first);
  assert(/class="allday-event cal-band cal-band--after"/.test(week), `Woche: dieselben Enden: ${week}`);
  assert(/grid-column:6 \/ span 3/.test(week), 'Woche: Spalte 1 ist die Zeitleiste, Fr ist Spalte 6');
  assert(/role="button" tabindex="0"/.test(week), 'das Band der Woche ist ein Knopf wie jeder Block');
  assert(/aria-hidden="true"/.test(month1) && !/tabindex/.test(month1), 'im Monat kein neuer Tab-Stopp: die Zelle traegt');

  // Die Kante: sie oeffnet sich per Klasse, und die Regel dafuer muss es geben.
  const before = [...eachRule(calendarCss)].find((r) => r.selector.trim() === '.cal-band--before');
  assert(before && /border-inline-start-width:\s*0/.test(before.body) && /border-start-start-radius:\s*0/.test(before.body),
    'die Fortsetzung traegt keine Kante und keine Rundung am Anfang');
});

test('Baender: im Nachbarmonat toent das Band zurueck wie der Chip der Zelle, nie ueber Opacity', () => {
  // Woche Mo 26.10. - So 01.11.2026 im Monat Oktober: So 01.11. liegt draussen.
  // Band A 30.10.-02.11. (Fr-So, letzte Spalte draussen), Band B 27.-29.10.
  // (ganz im Monat), Band C nur im Nachbarmonat.
  const days = bandDays('2026-10-26');
  const inMonth = days.map((d) => d < '2026-11-01');
  const { bands } = segmentsFor([
    bandEvent(11, '2026-10-30', '2026-11-02'),
    bandEvent(12, '2026-10-27', '2026-10-29'),
  ], days);
  const html = calendarHelpers.monthBandsHtml({ bands }, inMonth);
  const barOf = (id) => new RegExp(`<div class="[^"]*"[^>]*data-id="${id}"[\\s\\S]*?style="[^"]*"`).exec(html)?.[0] ?? '';
  const a = barOf(11);
  assert(/cal-band--outside/.test(a), `A laeuft in den November: ${a}`);
  assert(/--band-span:3;--band-out-start:0;--band-out-end:1;/.test(a), `A: drei Spalten, die letzte draussen: ${a}`);
  assert(!/cal-band--outside|--band-out/.test(barOf(12)), `B liegt ganz im Monat: ${barOf(12)}`);
  const prev = segmentsFor([bandEvent(13, '2026-09-29', '2026-10-01')], bandDays('2026-09-28')).bands;
  const c = calendarHelpers.monthBandsHtml({ bands: prev }, bandDays('2026-09-28').map((d) => d >= '2026-10-01'));
  assert(/--band-span:3;--band-out-start:2;--band-out-end:0;/.test(c), `Anfangsstueck aus dem September: ${c}`);

  // Die Regel: dieselbe Stufe wie `.month-day--outside .month-day__event`
  // (--tint-wash), ueber die Flaeche - keine Opacity, kein Filter.
  const rules = [...eachRule(calendarCss)];
  const chip = rules.find((r) => r.selector.trim() === '.month-day--outside .month-day__event');
  const band = rules.find((r) => r.selector.trim() === '.month-bands > .cal-band--outside');
  assert(chip && /var\(--tint-wash\)/.test(chip.body), 'der Chip im Nachbarmonat toent ueber --tint-wash');
  assert(band && /--band-out:\s*color-mix\(in srgb, var\(--ev-color\) var\(--tint-wash\), var\(--color-surface-work\)\)/.test(band.body),
    'das Band im Nachbarmonat nimmt dieselbe Stufe');
  assert(/background:\s*linear-gradient\(/.test(band.body) && /var\(--band-out-start\)/.test(band.body) && /var\(--band-out-end\)/.test(band.body),
    'der Verlauf setzt die Stopps an die Spaltengrenzen');
  assert(!/opacity|filter/.test(band.body), 'nie ueber Opacity auf Text');
});

test('Monatszelle: der Fokusring liegt ueber der Band-Schicht, die Zelle nicht', () => {
  // Ein Band liegt in `.month-bands` (z-index 1) ueber den Zellen. Hob sich die
  // fokussierte Zelle mit z-index 1 an, malte die spaetere Schicht trotzdem
  // darueber und deckte die Seiten des Rings. Hoebe sie sich hoeher, verschwaende
  // das Band unter ihrer Flaeche. Also: Ring auf ::after ueber der Schicht.
  const rules = [...eachRule(calendarCss)].filter((r) => r.at.length === 0);
  const zOf = (body) => Number(/(?:^|;|\s)z-index:\s*(-?\d+)/.exec(body)?.[1] ?? NaN);
  const layer = rules.find((r) => r.selector.trim() === '.month-bands');
  const cell = rules.find((r) => r.selector.trim() === '.month-day:focus-visible');
  const ring = rules.find((r) => r.selector.trim() === '.month-day:focus-visible::after');
  assert(layer && Number.isFinite(zOf(layer.body)), 'die Band-Schicht hebt sich per z-index');
  assert(cell && !/z-index/.test(cell.body), `die Zelle bildet keinen eigenen Stapel: ${cell?.body}`);
  assert(cell && /position:\s*relative/.test(cell.body), 'die Zelle ist Bezug fuer den Ring');
  assert(ring && zOf(ring.body) > zOf(layer.body), `der Ring steht ueber der Schicht: ${ring?.body}`);
  assert(/outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/.test(ring.body)
    && /outline-offset:\s*var\(--focus-ring-offset-inset\)/.test(ring.body), 'der Ring liest die Tokens, innen');
  assert(/position:\s*absolute/.test(ring.body) && /inset:\s*0/.test(ring.body) && /pointer-events:\s*none/.test(ring.body),
    'der Ring deckt die Zelle und faengt keinen Klick');
});

test('Baender: der gesprochene Name nennt Titel, Zeitraum und bei Fortsetzung „Fortsetzung"', () => {
  const span = calendarHelpers.spokenDateSpan('2026-10-13', '2026-10-15');
  assert(span === 'calendar.dateSpanSpoken{"from":"13.","to":"15. Oktober"}', `verdichtet „13. bis 15. Oktober": ${span}`);
  const across = calendarHelpers.spokenDateSpan('2026-12-30', '2027-01-02');
  assert(/"from":"30\. Dezember 2026","to":"2\. Januar 2027"/.test(across), `ueber den Jahreswechsel mit Jahr: ${across}`);
  assert(!/[\u2013\u2014]/.test(span + across), 'kein Gedankenstrich im gesprochenen Zeitraum');

  const ev = bandEvent(8, '2026-10-30', '2026-11-02', { title: 'Reise' });
  const [first] = segmentsFor([ev], bandDays('2026-10-26')).bands;
  const [second] = segmentsFor([ev], bandDays('2026-11-02')).bands;
  const label = (html) => (/aria-label="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&quot;', '"');
  const a = label(calendarHelpers.renderWeekBand(first));
  const b = label(calendarHelpers.renderWeekBand(second));
  assert(a.startsWith('Reise, calendar.dateSpanSpoken') && !a.includes('calendar.bandContinued'),
    `Anfang: Titel und Zeitraum, keine Fortsetzung: ${a}`);
  assert(b.includes('calendar.dateSpanSpoken') && b.includes('calendar.bandContinued'),
    `Folgewoche: Zeitraum und „Fortsetzung": ${b}`);
  // Die Tagesansicht zeigt dasselbe Stueck einzeln: Name mit Zeitraum und Tag.
  const day = label(calendarHelpers.renderAllDayEvent(ev, '2026-10-31'));
  assert(day.includes('calendar.dateSpanSpoken') && day.includes('calendar.bandContinued')
    && day.includes('calendar.multiDayPosition{"day":2,"total":4}'), `Tagesansicht, Tag 2: ${day}`);
});

test('Monatszelle und Liste: „Tag 2 von 3" und „und N weitere" (Re-Kritik 2026-09-25)', () => {
  const ev = bandEvent(9, '2026-10-13', '2026-10-15', { title: 'Städtereise' });
  assert(JSON.stringify(calendarHelpers.multiDayPosition(ev, '2026-10-14')) === '{"day":2,"count":3}', 'Tag 2 von 3');
  assert(calendarHelpers.multiDayPosition(ev, '2026-10-16') === null, 'ausserhalb: nichts');
  assert(calendarHelpers.multiDayPosition(bandEvent(10, '2026-10-13', '2026-10-13'), '2026-10-13') === null, 'eintaegig: nichts');
  const cell = calendarHelpers.monthDayAriaLabel('2026-10-14', 4,
    [ev, { title: 'A' }, { title: 'B' }, { title: 'C' }]);
  assert(cell.endsWith('Städtereise (calendar.multiDayPosition{"day":2,"total":3}), A, B calendar.monthDayMoreTitles{"count":1}'),
    `vier Eintraege, drei Titel, der Rest als Zahl: ${cell}`);
  const all = calendarHelpers.monthDayAriaLabel('2026-10-14', 2, [{ title: 'A' }, { title: 'B' }]);
  assert(!all.includes('monthDayMoreTitles'), `alle genannt, kein Rest: ${all}`);
  const row = calendarHelpers.renderAgendaEvent(ev, '2026-10-14');
  assert(/class="calendar-meta-item__day">calendar\.multiDayPosition\{&quot;day&quot;:2,&quot;total&quot;:3\}</.test(row),
    `die Listenzeile nennt den Tag sichtbar: ${row}`);
});

test('Monatszelle: ein Band ist kein Chip in seinen Zellen, zaehlt aber mit', () => {
  const ev = bandEvent(11, '2026-10-13', '2026-10-15', { title: 'Städtereise' });
  const previous = { ...calendarHelpers.state };
  try {
    Object.assign(calendarHelpers.state, {
      events: [ev], tasks: [], holidays: [], scheduleEntries: [], people: new Set(), hiddenSources: new Set(),
      assignedToMe: false, layerBirthdays: true, layerSchedule: false, layerWaste: false,
    });
    const band = segmentsFor([ev], bandDays('2026-10-12'));
    const html = calendarHelpers.renderMonthDay('2026-10-14', true, { band: { depth: band.depth[2], events: band.events } });
    assert(!/class="month-day__event"/.test(html), `kein Chip des Bands in der Zelle: ${html}`);
    assert(/data-total="1"/.test(html), 'die Zelle zaehlt das Band mit');
    assert(/class="month-day__lanes" style="--lanes:1"/.test(html), 'die Zelle haelt die Spur frei');
    const phone = calendarHelpers.renderMonthDay('2026-10-14', true, { split: true });
    assert(/class="month-day__event"/.test(phone), 'am Telefon bleibt es beim Punkt je Tag');
  } finally {
    Object.assign(calendarHelpers.state, previous);
  }
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Calendar-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
