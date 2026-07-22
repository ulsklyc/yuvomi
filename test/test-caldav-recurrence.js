// Repro für #549: CalDAV-Serien (iOS/Baikal) mit Wochentags-Wiederholung.
// Deckt den echten Live-Pfad ab: parseICS (Sync) -> DB-Event-Shape ->
// expandRecurringEvents (Lesen). Asserts kodieren das KORREKTE Verhalten;
// bestehende Bugs lassen die betroffenen Fälle fehlschlagen.
import { parseICS, normalizeRecurrenceOverrides } from '../server/services/ics-parser.js';
import { expandRecurringEvents } from '../server/services/calendar-events.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// Bildet nach, was caldav-sync.js beim Upsert in die DB schreibt
// (start_datetime=dtstart, all_day, end_datetime=dtend, recurrence_rule=rrule).
function syncedEvent(ics) {
  const [ev] = parseICS(ics);
  return {
    id: 1,
    start_datetime: ev.dtstart,
    end_datetime: ev.dtend,
    all_day: ev.allDay ? 1 : 0,
    recurrence_rule: ev.rrule,
  };
}

// Menge der Instanz-Tage (YYYY-MM-DD) innerhalb [from, to].
function occDays(ics, from, to) {
  const inst = expandRecurringEvents([syncedEvent(ics)], from, to);
  return inst.map((e) => e.start_datetime.slice(0, 10));
}

const VCAL = (body) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

console.log('\n[CalDAV-Recurrence-Test #549]\n');

// Wochentage der Testwoche 2026-07:
//   Sa 18 · So 19 · Mo 20 · Di 21 · Mi 22 · Do 23 · Fr 24 · Sa 25 · So 26

// --- Hypothese A: iOS "jeden Wochentag" als FREQ=DAILY;BYDAY=MO..FR ---
// Apple serialisiert Wochentags-Wiederholung teils als DAILY mit BYDAY.
// nextOccurrence() ignoriert BYDAY im DAILY-Zweig -> Sa/So erscheinen fälschlich.
test('DAILY;BYDAY=MO-FR: nur Werktage, kein Sa/So', () => {
  const ics = VCAL(
    'UID:daily-weekday@x\r\nSUMMARY:Schule\r\n' +
    'DTSTART:20260720T080000Z\r\nDTEND:20260720T090000Z\r\n' +
    'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'
  );
  const days = occDays(ics, '2026-07-20', '2026-07-26');
  assert(!days.includes('2026-07-25'), `Sa 25. darf nicht vorkommen: ${days.join()}`);
  assert(!days.includes('2026-07-26'), `So 26. darf nicht vorkommen: ${days.join()}`);
  assert(days.length === 5, `erwartet 5 Werktage, bekam ${days.length}: ${days.join()}`);
});

// --- Hypothese B: DTSTART fällt nicht auf einen BYDAY-Tag ---
// expandRecurringEvents emittiert die DTSTART-Instanz bedingungslos, auch wenn
// der Wochentag nicht in BYDAY liegt -> Phantom-Termin am Samstag.
test('WEEKLY;BYDAY=MO-FR mit DTSTART am Sa: keine Sa-Instanz', () => {
  const ics = VCAL(
    'UID:weekly-anchor-sat@x\r\nSUMMARY:Schule\r\n' +
    'DTSTART:20260718T080000Z\r\nDTEND:20260718T090000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  );
  const days = occDays(ics, '2026-07-18', '2026-07-24');
  assert(!days.includes('2026-07-18'), `Sa 18. (DTSTART) darf nicht erscheinen: ${days.join()}`);
  assert(days[0] === '2026-07-20', `erste Instanz sollte Mo 20. sein: ${days.join()}`);
  assert(days.length === 5, `erwartet Mo-Fr (5 Tage im Fenster), bekam ${days.length}: ${days.join()}`);
});

// --- Kontrolle: sauberer WEEKLY-Fall funktioniert (Engine grundsätzlich ok) ---
test('WEEKLY;BYDAY=MO-FR mit DTSTART am Mo: 5 Werktage (Kontrolle)', () => {
  const ics = VCAL(
    'UID:weekly-clean@x\r\nSUMMARY:Schule\r\n' +
    'DTSTART:20260720T080000Z\r\nDTEND:20260720T090000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  );
  const days = occDays(ics, '2026-07-20', '2026-07-26');
  assert(days.join() === '2026-07-20,2026-07-21,2026-07-22,2026-07-23,2026-07-24',
    `erwartet Mo-Fr, bekam: ${days.join()}`);
});

// --------------------------------------------------------
// #549 (Folge-Report Leon): Ein Kalenderobjekt enthält den Serien-Master PLUS
// geänderte Einzel-Vorkommen als RECURRENCE-ID-VEVENTs (gleiche UID). Der
// CalDAV/ICS-Inbound-Upsert schreibt per external_calendar_id — ohne
// normalizeRecurrenceOverrides überschreibt das (RRULE-lose) Override die
// Serie und die komplette Wochentags-Wiederholung verschwindet.
// --------------------------------------------------------

// Bildet den Inbound-Upsert EINES Kalenderobjekts nach: normalizeRecurrenceOverrides
// -> je eindeutiger UID eine DB-Zeile -> exdates als Ausnahmen-Map. Liefert genau
// das, was der Lese-Pfad (expandRecurringEvents + loadEventExceptions) konsumiert.
function syncObject(ics) {
  const normalized = normalizeRecurrenceOverrides(parseICS(ics));
  const rows = new Map();       // external uid -> row
  const exceptions = new Map(); // row.id -> Set<YYYY-MM-DD>
  let nextId = 1;
  for (const ev of normalized) {
    let row = rows.get(ev.uid);
    if (!row) { row = { id: nextId++ }; rows.set(ev.uid, row); }
    row.start_datetime  = ev.dtstart;
    row.end_datetime    = ev.dtend;
    row.all_day         = ev.allDay ? 1 : 0;
    row.recurrence_rule = ev.rrule;
    row.tzid            = ev.tzid ?? null;
    if (ev.rrule && Array.isArray(ev.exdates) && ev.exdates.length) {
      if (!exceptions.has(row.id)) exceptions.set(row.id, new Set());
      for (const d of ev.exdates) exceptions.get(row.id).add(d);
    }
  }
  return { events: [...rows.values()], exceptions };
}

function instancesMulti(ics, from, to) {
  const { events, exceptions } = syncObject(ics);
  return expandRecurringEvents(events, from, to, exceptions)
    .sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
}
function occDaysMulti(ics, from, to) {
  return instancesMulti(ics, from, to).map((e) => e.start_datetime.slice(0, 10));
}

// Master (MO,TU) + ein verlegtes Vorkommen (Di 21.07. → 10:00 Uhr).
const MASTER_PLUS_OVERRIDE =
  'BEGIN:VCALENDAR\r\n' +
  'BEGIN:VEVENT\r\nUID:series@x\r\nSUMMARY:Schule\r\n' +
  'DTSTART:20260720T080000Z\r\nDTEND:20260720T090000Z\r\n' +
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU\r\nEND:VEVENT\r\n' +
  'BEGIN:VEVENT\r\nUID:series@x\r\nSUMMARY:Schule (verlegt)\r\n' +
  'RECURRENCE-ID:20260721T080000Z\r\n' +
  'DTSTART:20260721T100000Z\r\nDTEND:20260721T110000Z\r\nEND:VEVENT\r\n' +
  'END:VCALENDAR';

test('Master+RECURRENCE-ID: Serie überlebt (kein Collapse zum Einzeltermin)', () => {
  const { events } = syncObject(MASTER_PLUS_OVERRIDE);
  const master = events.find((e) => e.recurrence_rule);
  assert(master, 'Master-Zeile mit RRULE muss existieren (nicht überschrieben)');
  assert(/BYDAY=MO,TU/.test(master.recurrence_rule), `RRULE erhalten: ${master.recurrence_rule}`);
  assert(master.start_datetime.slice(0, 10) === '2026-07-20',
    `Master-Start bleibt Mo 20.07.: ${master.start_datetime}`);
});

test('Master+RECURRENCE-ID: Serie läuft über Wochen weiter (nicht kollabiert)', () => {
  const days = occDaysMulti(MASTER_PLUS_OVERRIDE, '2026-07-20', '2026-08-03');
  // Mo/Di jede Woche: 20,21 · 27,28 · 03. (21. kommt vom Override, s.u.)
  for (const d of ['2026-07-20', '2026-07-27', '2026-07-28', '2026-08-03']) {
    assert(days.includes(d), `${d} muss vorkommen: ${days.join()}`);
  }
});

test('RECURRENCE-ID: Original-Slot unterdrückt, verlegte Instanz sichtbar (kein Doppel)', () => {
  const inst = instancesMulti(MASTER_PLUS_OVERRIDE, '2026-07-20', '2026-07-26');
  const on21 = inst.filter((e) => e.start_datetime.slice(0, 10) === '2026-07-21');
  assert(on21.length === 1, `genau eine Instanz am 21.07. (kein Original+Override-Doppel): ${on21.length}`);
  assert(on21[0].start_datetime.includes('T10:00:00'),
    `die sichtbare 21.07.-Instanz ist die verlegte (10:00): ${on21[0].start_datetime}`);
});

test('CalDAV-EXDATE wird als Ausnahme angewandt (Feiertag fällt aus)', () => {
  const ics =
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:exd@x\r\nSUMMARY:Schule\r\n' +
    'DTSTART:20260720T080000Z\r\nDTEND:20260720T090000Z\r\n' +
    'EXDATE:20260727T080000Z\r\n' +            // Mo 27.07. ausgenommen
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const days = occDaysMulti(ics, '2026-07-20', '2026-08-01');
  assert(!days.includes('2026-07-27'), `Mo 27.07. muss ausfallen (EXDATE): ${days.join()}`);
  assert(days.includes('2026-07-20') && days.includes('2026-07-28'),
    `andere Werktage bleiben: ${days.join()}`);
});

// --------------------------------------------------------
// #549 (DST): Eine TZID-Serie muss über die Sommer-/Winterzeit-Grenze die LOKALE
// Uhrzeit behalten. Zuvor übernahm die Expansion den festen UTC-Suffix des Masters,
// sodass die Anzeige im Winter eine Stunde zu früh lag.
// --------------------------------------------------------

// Lokale Wanduhrzeit (HH:MM Europe/Berlin) einer Instanz.
function localHM(iso) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

// Master DTSTART im Sommer (CEST): Mi 24.09.2025, 07:25 Europe/Berlin, wöchentlich.
const TZ_SERIES =
  'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:tz@x\r\nSUMMARY:Schule\r\n' +
  'DTSTART;TZID=Europe/Berlin:20250924T072500\r\n' +
  'DTEND;TZID=Europe/Berlin:20250924T081000\r\n' +
  'RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';

test('TZID-Serie: gleiche Ortszeit im Sommer UND Winter (kein DST-Drift)', () => {
  const summer = instancesMulti(TZ_SERIES, '2026-04-01', '2026-04-02'); // CEST
  const winter = instancesMulti(TZ_SERIES, '2025-12-10', '2025-12-11'); // CET
  assert(summer.length === 1 && winter.length === 1, `je 1 Instanz: ${summer.length}/${winter.length}`);
  assert(localHM(summer[0].start_datetime) === '07:25', `Sommer 07:25: ${localHM(summer[0].start_datetime)}`);
  assert(localHM(winter[0].start_datetime) === '07:25', `Winter 07:25 (nicht 06:25): ${localHM(winter[0].start_datetime)}`);
});

test('TZID-Serie: Instanz bleibt am korrekten Wochentag (Mi, Tag-24-Master)', () => {
  const inst = instancesMulti(TZ_SERIES, '2025-12-10', '2025-12-11'); // Mi 10.12.
  assert(inst[0].start_datetime.slice(0, 10) === '2025-12-10', `Datum: ${inst[0].start_datetime}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
