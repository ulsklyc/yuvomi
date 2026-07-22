import { unfoldLines, unescapeICSText, parseICS, parseVTODO, expandRRULE, tzLocalToUTC } from '../server/services/ics-parser.js';
import { resolveIcalColor } from '../server/utils/ical-color.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

console.log('\n[ICS-Parser-Test]\n');

test('unfoldLines entfaltet Zeilenfortsetzungen', () => {
  const result = unfoldLines('SUMMARY:Hallo\r\n Welt');
  assert(result === 'SUMMARY:HalloWelt', `got: ${result}`);
});

test('parseICS: einfaches Ganztags-Event', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:test-1@x\r\nSUMMARY:Geburtstag\r\nDTSTART;VALUE=DATE:20260501\r\nDTEND;VALUE=DATE:20260502\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const events = parseICS(ics);
  assert(events.length === 1, `expected 1, got ${events.length}`);
  assert(events[0].uid === 'test-1@x', 'uid');
  assert(events[0].dtstart === '2026-05-01', `dtstart: ${events[0].dtstart}`);
  assert(events[0].dtend   === '2026-05-01', `dtend: ${events[0].dtend}`);
  assert(events[0].allDay  === true, 'allDay');
});

test('parseICS: Event ohne UID wird übersprungen', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Ohne UID\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert(parseICS(ics).length === 0, 'should skip event without UID');
});

test('parseICS: UTC datetime', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:utc@x\r\nSUMMARY:Meeting\r\nDTSTART:20260615T140000Z\r\nDTEND:20260615T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(ev.dtstart === '2026-06-15T14:00:00Z', `dtstart: ${ev.dtstart}`);
  assert(ev.allDay  === false, 'allDay');
});

test('expandRRULE: WEEKLY 3-Wochen-Fenster', () => {
  const vevent = {
    uid: 'weekly@x', summary: 'Wöchentlich', description: null, location: null,
    dtstart: '2026-04-13', dtend: '2026-04-13', rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', allDay: true,
  };
  const occ = expandRRULE(vevent, '2026-04-13', '2026-05-04');
  assert(occ.length >= 3, `expected >=3, got ${occ.length}`);
  assert(occ[0].uid === 'weekly@x__2026-04-13', `uid: ${occ[0].uid}`);
  assert(occ[0].rrule === null, 'expanded events have null rrule');
});

test('parseICS: EXDATE wird als Instanz-Datum geparst (TZID, #513)', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ex@x\r\nSUMMARY:Turnen\r\nDTSTART;TZID=Europe/Vienna:20240930T170000\r\nRRULE:FREQ=WEEKLY;COUNT=10\r\nEXDATE;TZID=Europe/Vienna:20241125T170000\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(JSON.stringify(ev.exdates) === JSON.stringify(['2024-11-25']), `exdates: ${JSON.stringify(ev.exdates)}`);
});

test('parseICS: mehrere/komma-separierte EXDATE-Werte (#513)', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ex2@x\r\nSUMMARY:Multi\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20260102T090000Z,20260103T090000Z\r\nEXDATE:20260104T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(JSON.stringify(ev.exdates) === JSON.stringify(['2026-01-02', '2026-01-03', '2026-01-04']), `exdates: ${JSON.stringify(ev.exdates)}`);
});

test('expandRRULE: COUNT zählt EXDATE-Vorkommen mit (#513)', () => {
  const vevent = {
    uid: 'exc@x', summary: 'X', description: null, location: null,
    dtstart: '2026-01-01', dtend: '2026-01-01', rrule: 'RRULE:FREQ=DAILY;COUNT=3',
    allDay: true, exdates: ['2026-01-02'],
  };
  const occ = expandRRULE(vevent, '2026-01-01', '2026-12-31');
  // COUNT=3 → 3 Instanzen (01,02,03), 02 ausgenommen → 2 sichtbar, NICHT bis 04.
  assert(JSON.stringify(occ.map((e) => e.dtstart)) === JSON.stringify(['2026-01-01', '2026-01-03']), `got: ${JSON.stringify(occ.map((e) => e.dtstart))}`);
});

test('unescapeICSText: unescapes special sequences', () => {
  assert(unescapeICSText('Main Street\\, London') === 'Main Street, London', 'comma');
  assert(unescapeICSText('Notes\\;Details') === 'Notes;Details', 'semicolon');
  assert(unescapeICSText('Line1\\nLine2') === 'Line1\nLine2', 'newline');
  assert(unescapeICSText('C:\\\\path') === 'C:\\path', 'backslash');
  assert(unescapeICSText(null) === null, 'null passthrough');
});

test('parseICS: unescape text fields', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:esc@x\r\nSUMMARY:Dinner\\, Party\r\nLOCATION:Main St\\, City\r\nDTSTART:20260615T180000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(ev.summary === 'Dinner, Party', `summary: ${ev.summary}`);
  assert(ev.location === 'Main St, City', `location: ${ev.location}`);
});

test('expandRRULE: null rrule → leeres Array', () => {
  const v = { uid: 'x', summary: 'x', description: null, location: null,
              dtstart: '2026-04-20', dtend: null, rrule: null, allDay: true };
  assert(expandRRULE(v, '2026-01-01', '2026-12-31').length === 0);
});

// --------------------------------------------------------
// parseVTODO (Apple Reminders / CalDAV VTODO components)
// --------------------------------------------------------

test('parseVTODO: einfacher offener Reminder', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:todo-1@x\r\nSUMMARY:Milch kaufen\r\nEND:VTODO\r\nEND:VCALENDAR';
  const todos = parseVTODO(ics);
  assert(todos.length === 1, `expected 1, got ${todos.length}`);
  assert(todos[0].uid === 'todo-1@x', 'uid');
  assert(todos[0].summary === 'Milch kaufen', `summary: ${todos[0].summary}`);
  assert(todos[0].completed === false, 'completed should default false');
  assert(todos[0].due === null, 'due should be null');
  assert(todos[0].priority === null, 'priority should be null');
});

test('parseVTODO: STATUS:COMPLETED markiert als erledigt', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:todo-2@x\r\nSUMMARY:Erledigt\r\nSTATUS:COMPLETED\r\nCOMPLETED:20260601T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.completed === true, 'completed should be true');
  assert(t.status === 'completed', `status: ${t.status}`);
});

test('parseVTODO: COMPLETED-Zeitstempel ohne STATUS gilt als erledigt', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:todo-3@x\r\nSUMMARY:Fertig\r\nCOMPLETED:20260601T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.completed === true, 'completed should be true');
});

test('parseVTODO: DUE als reines Datum', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:todo-4@x\r\nSUMMARY:Termin\r\nDUE;VALUE=DATE:20260701\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.due === '2026-07-01', `due: ${t.due}`);
});

test('parseVTODO: DUE mit UTC-Zeit', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:todo-5@x\r\nSUMMARY:Anruf\r\nDUE:20260701T143000Z\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.due === '2026-07-01T14:30:00Z', `due: ${t.due}`);
});

test('parseVTODO: PRIORITY wird als Zahl gelesen, 0 → null', () => {
  const ics1 = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:p1@x\r\nSUMMARY:Wichtig\r\nPRIORITY:1\r\nEND:VTODO\r\nEND:VCALENDAR';
  assert(parseVTODO(ics1)[0].priority === 1, 'priority 1');
  const ics0 = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:p0@x\r\nSUMMARY:Egal\r\nPRIORITY:0\r\nEND:VTODO\r\nEND:VCALENDAR';
  assert(parseVTODO(ics0)[0].priority === null, 'priority 0 → null');
});

test('parseVTODO: VTODO ohne UID wird übersprungen', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:Ohne UID\r\nEND:VTODO\r\nEND:VCALENDAR';
  assert(parseVTODO(ics).length === 0, 'should skip VTODO without UID');
});

test('parseVTODO: unescape von Summary und Description', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:esc@x\r\nSUMMARY:Eier\\, Mehl\r\nDESCRIPTION:Zeile1\\nZeile2\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.summary === 'Eier, Mehl', `summary: ${t.summary}`);
  assert(t.description === 'Zeile1\nZeile2', `description: ${t.description}`);
});

test('parseVTODO: mehrere VTODOs in einer Collection', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:a@x\r\nSUMMARY:A\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:b@x\r\nSUMMARY:B\r\nEND:VTODO\r\nEND:VCALENDAR';
  const todos = parseVTODO(ics);
  assert(todos.length === 2, `expected 2, got ${todos.length}`);
});

test('parseVTODO: ignoriert VEVENT-Komponenten', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ev@x\r\nSUMMARY:Event\r\nDTSTART:20260615T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert(parseVTODO(ics).length === 0, 'should not parse VEVENT as VTODO');
});

// --- ReDoS-Härtung der Parameter-Parsing-Regexes (CodeQL js/redos, Alert #10) ---
// Bösartige DUE/DTSTART-Zeile: viele ';' ohne abschließendes ':' lösen beim
// anfälligen Muster /((?:;[^:]*)*)/ katastrophales Backtracking aus.
function elapsed(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6; // ms
}

test('parseVTODO: bösartige DUE-Parameter verursachen kein ReDoS', () => {
  const evil = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:redos@x\r\nSUMMARY:X\r\nDUE'
    + ';'.repeat(28) + '\r\nEND:VTODO\r\nEND:VCALENDAR';
  const ms = elapsed(() => parseVTODO(evil));
  assert(ms < 200, `DUE-Parsing dauerte ${ms.toFixed(1)} ms (ReDoS-Verdacht)`);
});

test('parseICS: bösartige DTSTART-Parameter verursachen kein ReDoS', () => {
  const evil = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:redos@x\r\nSUMMARY:X\r\nDTSTART'
    + ';'.repeat(28) + '\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const ms = elapsed(() => parseICS(evil));
  assert(ms < 200, `DTSTART-Parsing dauerte ${ms.toFixed(1)} ms (ReDoS-Verdacht)`);
});

test('parseVTODO: gültige DUE mit mehreren Parametern wird weiter korrekt geparst', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:due-params@x\r\nSUMMARY:X\r\n'
    + 'DUE;X-FOO=bar;TZID=Europe/Berlin:20260615T140000\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.due === '2026-06-15T12:00:00Z', `due: ${t.due}`);  // 14:00 Berlin = 12:00 UTC
});

// --- VALUE=DATE-TIME darf nicht als reines DATE behandelt werden ---
// Bug: /;VALUE=DATE\b/ matchte wegen der Wortgrenze auch "VALUE=DATE-TIME"
// und verwarf so die Uhrzeit.
test('parseVTODO: DUE mit VALUE=DATE-TIME behält die Uhrzeit', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:dt@x\r\nSUMMARY:X\r\n'
    + 'DUE;TZID=Europe/Berlin;VALUE=DATE-TIME:20260615T140000\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.due === '2026-06-15T12:00:00Z', `due: ${t.due}`);  // 14:00 Berlin = 12:00 UTC
});

test('parseVTODO: DUE mit VALUE=DATE bleibt reines Datum', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:do@x\r\nSUMMARY:X\r\n'
    + 'DUE;VALUE=DATE:20260615\r\nEND:VTODO\r\nEND:VCALENDAR';
  const [t] = parseVTODO(ics);
  assert(t.due === '2026-06-15', `due: ${t.due}`);
});

// --------------------------------------------------------
// resolveIcalColor + COLOR-Property (RFC 7986)
// --------------------------------------------------------
test('resolveIcalColor: CSS3-Name → Hex', () => {
  assert(resolveIcalColor('cornflowerblue') === '#6495ED', resolveIcalColor('cornflowerblue'));
});

test('resolveIcalColor: Groß-/Kleinschreibung und Whitespace egal', () => {
  assert(resolveIcalColor('  Tomato  ') === '#FF6347', resolveIcalColor('  Tomato  '));
});

test('resolveIcalColor: grey/gray-Synonym', () => {
  assert(resolveIcalColor('grey') === '#808080', 'grey');
});

test('resolveIcalColor: Hex direkt wird durchgereicht (uppercase)', () => {
  assert(resolveIcalColor('#a4bdfc') === '#A4BDFC', resolveIcalColor('#a4bdfc'));
});

test('resolveIcalColor: #RGB-Kurzform wird expandiert', () => {
  assert(resolveIcalColor('#0f0') === '#00FF00', resolveIcalColor('#0f0'));
});

test('resolveIcalColor: optionaler Parameter hinter dem Namen wird abgeschnitten', () => {
  assert(resolveIcalColor('red;X-FOO=bar') === '#FF0000', resolveIcalColor('red;X-FOO=bar'));
});

test('resolveIcalColor: unbekannter Name → null', () => {
  assert(resolveIcalColor('notacolor') === null, 'unknown');
});

test('resolveIcalColor: leer/kein String → null', () => {
  assert(resolveIcalColor('') === null && resolveIcalColor(null) === null
    && resolveIcalColor(undefined) === null, 'empty');
});

test('parseICS: COLOR-Property wird zur Event-Eigenfarbe', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:col@x\r\nSUMMARY:Bunt\r\n'
    + 'DTSTART:20260615T140000Z\r\nDTEND:20260615T150000Z\r\nCOLOR:cornflowerblue\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(ev.color === '#6495ED', `color: ${ev.color}`);
});

test('parseICS: fehlende COLOR-Property → color null', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:nocol@x\r\nSUMMARY:Neutral\r\n'
    + 'DTSTART:20260615T140000Z\r\nDTEND:20260615T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(ev.color === null, `color: ${ev.color}`);
});

test('expandRRULE: Event-Eigenfarbe wird auf alle Instanzen übertragen', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:colrec@x\r\nSUMMARY:Serie\r\n'
    + 'DTSTART:20260601T090000Z\r\nDTEND:20260601T100000Z\r\nCOLOR:tomato\r\n'
    + 'RRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [vevent] = parseICS(ics);
  const occ = expandRRULE(vevent, '2026-06-01', '2026-06-10');
  assert(occ.length === 3, `count: ${occ.length}`);
  assert(occ.every((o) => o.color === '#FF6347'), 'all instances keep the color');
});

// #549-Folge: Die '24' -> 0 Sonderregel im TZID-Konverter galt für JEDES Feld,
// nicht nur die Stunde. Dadurch wurde der Tages-Wert 24 zu 0 -> Date.UTC(...,0)
// rutschte in den Vormonat -> ein Termin am 24. landete auf einem falschen Datum
// (Leons Mittwochs-Serie am 24. erschien am Samstag).
test('tzLocalToUTC: Tag 24 bleibt der 24. (nicht in den Vormonat)', () => {
  const r = tzLocalToUTC('2025-09-24T07:25:00', 'Europe/Berlin');
  assert(r === '2025-09-24T05:25:00Z', `24.09. 07:25 CEST -> ${r}`);
});

test('tzLocalToUTC: Minute 24 bleibt erhalten (Sonderregel nur für Stunde)', () => {
  const r = tzLocalToUTC('2025-09-10T08:24:00', 'Europe/Berlin');
  assert(r === '2025-09-10T06:24:00Z', `08:24 CEST -> ${r}`);
});

test('parseICS: TZID-Serie mit DTSTART am 24. behält Datum + Wochentag', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:wed24@x\r\nSUMMARY:Schule\r\n'
    + 'DTSTART;TZID=Europe/Berlin:20250924T072500\r\n'
    + 'DTEND;TZID=Europe/Berlin:20250924T161000\r\n'
    + 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  assert(ev.dtstart.slice(0, 10) === '2025-09-24', `dtstart-Datum: ${ev.dtstart}`);
  // 24.09.2025 ist ein Mittwoch (UTC-Tag des gespeicherten 05:25Z-Instants).
  assert(new Date(ev.dtstart).getUTCDay() === 3, `Wochentag sollte Mi(3) sein: ${ev.dtstart}`);
});

test('expandRRULE: TZID-Serie hält Ortszeit über die DST-Grenze (kein Winter-Drift)', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:tzr@x\r\nSUMMARY:Schule\r\n'
    + 'DTSTART;TZID=Europe/Berlin:20250924T072500\r\nDTEND;TZID=Europe/Berlin:20250924T081000\r\n'
    + 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [ev] = parseICS(ics);
  const hm = (iso) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const winter = expandRRULE(ev, '2025-12-10', '2025-12-10'); // CET
  const summer = expandRRULE(ev, '2026-04-01', '2026-04-01'); // CEST
  assert(winter.length === 1 && hm(winter[0].dtstart) === '07:25', `Winter 07:25 (nicht 06:25): ${winter[0] && hm(winter[0].dtstart)}`);
  assert(summer.length === 1 && hm(summer[0].dtstart) === '07:25', `Sommer 07:25: ${summer[0] && hm(summer[0].dtstart)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
