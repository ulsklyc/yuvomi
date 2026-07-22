// Repro für #549: CalDAV-Serien (iOS/Baikal) mit Wochentags-Wiederholung.
// Deckt den echten Live-Pfad ab: parseICS (Sync) -> DB-Event-Shape ->
// expandRecurringEvents (Lesen). Asserts kodieren das KORREKTE Verhalten;
// bestehende Bugs lassen die betroffenen Fälle fehlschlagen.
import { parseICS } from '../server/services/ics-parser.js';
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
