/**
 * Test: EINE Uhr fuer die Vorkommen einer Serie (#2034, Schritt 1).
 *
 * Die Serien-Expansion (`expandRecurringEvents`) und der Abo-Pfad
 * (`expandRRULE`) schreiben die Wanduhr einer Serie Tag fuer Tag fort und
 * rechneten je Vorkommen ueber `localToUTC()` zurueck. Das liest den Offset an
 * der falschen Stelle: am Umstellungstag stand ein Vorkommen eine Stunde
 * daneben (Europe/Berlin, taeglich 01:30: am 25.03.2035 23:30Z des Vortags
 * statt 00:30Z). Jetzt gilt `localToUTCOccurrence()` mit zwei festgenagelten
 * Regeln (RFC 5545, 3.3.5):
 *   - Luecke (die Wanduhrzeit gibt es nicht): um die Lueckenbreite nach vorn;
 *   - Doppelstunde (die Wanduhrzeit gibt es zweimal): das ERSTE Auftreten.
 *
 * Erwartete Zeitpunkte sind von Hand nachgerechnet und werden zusaetzlich
 * gegen eine eigene `Intl`-Uhr geprueft (nicht gegen den Code unter Test).
 *
 * DER ALTE TAGESSCHLUESSEL BEHAELT SEINE BEDEUTUNG. Seit Schritt 4 ist
 * `recurrence_identity` der Originalstart in Format A; eine Ausnahme in der
 * alten Form (lokal oder importiert) wird weiter ueber die alte Uhr gelesen
 * (legacy-occurrence-key.js) und trifft, was sie auf main traf. Das pinnt
 * der letzte Block.
 *
 * Das Skript faehrt die Datei unter TZ=UTC und America/Chicago. Die Tage
 * liegen 2035.
 *
 * Ausfuehren: npm run test:series-dst-clock
 */

process.env.TZ = process.env.TZ || 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

const { localToUTCOccurrence, localToUTCPrecise } = await import('../server/utils/timezone.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { expandRRULE, parseICS } = await import('../server/services/ics-parser.js');

/** Wanduhr eines Zeitpunkts in einer Zone, eigene Intl-Rechnung. */
function wallOf(iso, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}

const hour = 3600000;

test('localToUTCOccurrence: Umstellungstag, Luecke und Doppelstunde', () => {
  const cases = [
    // [Wanduhr, Zone, erwartet, Art]
    ['2035-03-25T01:30:00', 'Europe/Berlin', '2035-03-25T00:30:00Z', 'vor der Luecke, CET'],
    ['2035-03-25T02:30:00', 'Europe/Berlin', '2035-03-25T01:30:00Z', 'Luecke -> 03:30 CEST'],
    ['2035-10-28T01:30:00', 'Europe/Berlin', '2035-10-27T23:30:00Z', 'vor der Doppelstunde, CEST'],
    ['2035-10-28T02:30:00', 'Europe/Berlin', '2035-10-28T00:30:00Z', 'Doppelstunde -> erstes (CEST)'],
    ['2035-10-28T03:30:00', 'Europe/Berlin', '2035-10-28T02:30:00Z', 'nach der Doppelstunde, CET'],
    ['2035-03-11T02:30:00', 'America/New_York', '2035-03-11T07:30:00Z', 'Luecke -> 03:30 EDT'],
    ['2035-03-11T03:30:00', 'America/New_York', '2035-03-11T07:30:00Z', 'nach der Luecke, EDT'],
    ['2035-11-04T01:30:00', 'America/New_York', '2035-11-04T05:30:00Z', 'Doppelstunde -> erstes (EDT)'],
    ['2035-04-01T02:30:00', 'Australia/Sydney', '2035-03-31T15:30:00Z', 'Doppelstunde -> erstes (AEDT)'],
    ['2035-10-07T02:30:00', 'Australia/Sydney', '2035-10-06T16:30:00Z', 'Luecke -> 03:30 AEDT'],
    ['2035-04-01T01:45:00', 'Australia/Lord_Howe', '2035-03-31T14:45:00Z', 'halbstuendige Doppelstunde -> erstes'],
    ['2035-10-07T02:15:00', 'Australia/Lord_Howe', '2035-10-06T15:45:00Z', 'halbstuendige Luecke -> 02:45'],
    ['2035-04-01T03:30:00', 'Pacific/Chatham', '2035-03-31T13:45:00Z', 'Doppelstunde bei +13:45 -> erstes'],
  ];
  for (const [local, zone, expected, kind] of cases) {
    const got = localToUTCOccurrence(local, zone);
    assert.equal(got, expected, `${zone} ${local} (${kind})`);
    const wall = wallOf(got, zone);
    if (/Luecke ->/.test(kind)) {
      // RFC 5545: um die Lueckenbreite nach vorn - die Wanduhr liegt spaeter.
      assert.ok(wall > local, `${zone} ${local}: ${wall} liegt hinter der Luecke`);
    } else {
      assert.equal(wall, local, `${zone} ${local}: Rundlauf ueber Intl`);
    }
    if (/Doppelstunde ->/.test(kind)) {
      // Erstes Auftreten: dieselbe Wanduhr eine Faltenbreite frueher gibt es nicht.
      for (const width of [hour, hour / 2]) {
        assert.notEqual(wallOf(new Date(Date.parse(got) - width).toISOString(), zone), local,
          `${zone} ${local}: nicht das zweite Auftreten`);
      }
    }
  }
});

test('localToUTCOccurrence: Sekundenbruchteil bleibt, ungueltige Eingabe faellt durch', () => {
  assert.equal(localToUTCOccurrence('2035-10-28T02:30:00.250', 'Europe/Berlin'), '2035-10-28T00:30:00.250Z');
  assert.equal(localToUTCOccurrence('kein-datum', 'Europe/Berlin'), localToUTCPrecise('kein-datum', 'Europe/Berlin'));
  // Ausserhalb jeder Umstellung dieselbe Antwort wie die genaue Fassung.
  assert.equal(localToUTCOccurrence('2035-07-01T09:00:00', 'Europe/Berlin'), '2035-07-01T07:00:00Z');
});

function series({ id, start, tzid, rule = 'FREQ=DAILY' }) {
  return {
    id, start_datetime: start, end_datetime: new Date(Date.parse(start) + hour).toISOString().replace('.000Z', 'Z'),
    recurrence_rule: rule, tzid, all_day: 0,
  };
}

function startsOn(rows, zone, localDay) {
  return rows.filter((r) => wallOf(r.start_datetime ?? r.dtstart, zone).slice(0, 10) === localDay);
}

const expansionCases = [
  // Start im Winter: lokaler Tag == UTC-Tag (tzAware-Zweig).
  { label: 'Berlin 01:30, Start Winter', start: '2035-01-10T00:30:00Z', zone: 'Europe/Berlin',
    expect: { '2035-03-25': '2035-03-25T00:30:00Z', '2035-10-28': '2035-10-27T23:30:00Z' } },
  // Start im Sommer: 01:30 CEST = 23:30Z des Vortags (lokale Rechnung, #985).
  { label: 'Berlin 01:30, Start Sommer', start: '2034-07-09T23:30:00Z', zone: 'Europe/Berlin',
    expect: { '2035-03-25': '2035-03-25T00:30:00Z', '2035-10-28': '2035-10-27T23:30:00Z' } },
  { label: 'Berlin 02:30 (Luecke und Doppelstunde)', start: '2035-01-10T01:30:00Z', zone: 'Europe/Berlin',
    expect: { '2035-03-25': '2035-03-25T01:30:00Z', '2035-10-28': '2035-10-28T00:30:00Z' } },
  { label: 'New York 02:30 / 01:30', start: '2035-01-10T07:30:00Z', zone: 'America/New_York',
    expect: { '2035-03-11': '2035-03-11T07:30:00Z' } },
  { label: 'New York 01:30 (Doppelstunde)', start: '2035-01-10T06:30:00Z', zone: 'America/New_York',
    expect: { '2035-11-04': '2035-11-04T05:30:00Z' } },
  { label: 'Sydney 22:30 am Vorabend der Umstellung', start: '2035-01-10T11:30:00Z', zone: 'Australia/Sydney',
    expect: { '2035-03-31': '2035-03-31T11:30:00Z', '2035-10-06': '2035-10-06T12:30:00Z' } },
];

test('expandRecurringEvents: das Vorkommen am Umstellungstag steht zur richtigen Zeit', () => {
  let id = 1;
  for (const c of expansionCases) {
    const rows = expandRecurringEvents([series({ id: id++, start: c.start, tzid: c.zone })],
      '2035-01-01', '2035-12-31', null, { includeRecurrenceIdentity: true, maxIterations: 5000 });
    for (const [localDay, expected] of Object.entries(c.expect)) {
      const hits = rows.filter((r) => r.start_datetime === expected);
      assert.equal(hits.length, 1, `${c.label}: ein Vorkommen um ${expected} (lokal ${localDay})`);
      const end = hits[0].end_datetime;
      assert.equal(Date.parse(end) - Date.parse(expected), hour, `${c.label}: Dauer bleibt eine Stunde`);
    }
  }
});

test('expandRRULE (Abo-Pfad): dieselbe Uhr', () => {
  for (const c of expansionCases) {
    // Der Abo-Pfad kennt keine lokale Rechnung (#985): nur Serien, deren
    // lokaler Tag am Start dem UTC-Tag gleicht, laufen ueber die Wanduhr.
    if (wallOf(c.start, c.zone).slice(0, 10) !== c.start.slice(0, 10)) continue;
    const vevent = {
      uid: 'dst', dtstart: c.start, dtend: new Date(Date.parse(c.start) + hour).toISOString().replace('.000Z', 'Z'),
      rrule: 'FREQ=DAILY', tzid: c.zone, allDay: false, exdates: [],
    };
    const rows = expandRRULE(vevent, '2035-01-01', '2035-12-31');
    for (const [localDay, expected] of Object.entries(c.expect)) {
      const hits = rows.filter((r) => r.dtstart === expected);
      assert.equal(hits.length, 1, `${c.label}: ein Vorkommen um ${expected} (lokal ${localDay})`);
      assert.equal(Date.parse(hits[0].dtend) - Date.parse(expected), hour, `${c.label}: Dauer`);
    }
  }
});

test('UNTIL als Ortszeit der Serie: dieselbe Uhr wie die Vorkommen', () => {
  // UNTIL nennt genau das Vorkommen am Umstellungstag (Doppelstunde, erstes
  // Auftreten): es gehoert noch dazu, der Tag danach nicht mehr.
  const ev = series({ id: 50, start: '2035-10-20T00:30:00Z', tzid: 'Europe/Berlin',
    rule: 'FREQ=DAILY;UNTIL=20351028T023000' });
  const rows = expandRecurringEvents([ev], '2035-10-01', '2035-11-30', null, { maxIterations: 5000 });
  assert.equal(rows.at(-1).start_datetime, '2035-10-28T00:30:00Z');
  const vevent = { uid: 'u', dtstart: ev.start_datetime, dtend: ev.end_datetime, rrule: ev.recurrence_rule,
    tzid: 'Europe/Berlin', allDay: false, exdates: [] };
  assert.equal(expandRRULE(vevent, '2035-10-01', '2035-11-30').at(-1).dtstart, '2035-10-28T00:30:00Z');
});

test('Schluessel ab Schritt 4 eindeutig, alte Ausnahmen und Importe wie auf main', () => {
  // Berlin 01:30, Start im Sommer: die einzige Lage, in der die neue Uhr den
  // UTC-Tag eines Vorkommens verschieben wuerde (gemessen an einem Sweep ueber
  // 14 Zonen, halbstuendlich: Berlin 01:xx, Helsinki/Jerusalem 02:xx).
  const ev = series({ id: 70, start: '2034-07-09T23:30:00Z', tzid: 'Europe/Berlin' });
  const opts = { includeRecurrenceIdentity: true, maxIterations: 5000 };
  const rows = expandRecurringEvents([ev], '2035-03-20', '2035-11-02', null, opts);
  const idOn = (localDay) => startsOn(rows, 'Europe/Berlin', localDay).map((r) => r.recurrence_identity);
  // Seit Schritt 4 (#2034) ist die Identitaet der Originalstart in UTC: die
  // Kollision von main (24. und 25.03. teilten `2035-03-24`) ist weg.
  assert.deepEqual(idOn('2035-03-24'), ['2035-03-24T00:30:00Z']);
  assert.deepEqual(idOn('2035-03-25'), ['2035-03-25T00:30:00Z']);
  assert.deepEqual(idOn('2035-10-28'), ['2035-10-27T23:30:00Z']);
  assert.deepEqual(idOn('2035-10-27'), ['2035-10-26T23:30:00Z']);

  // Eine lokal abgelegte Ausnahme mit dem Schluessel, den der Kalender gezeigt
  // hat, nimmt weiter genau das Vorkommen heraus, das sie auf main herausnahm.
  const without = (key) => expandRecurringEvents([ev], '2035-03-20', '2035-11-02',
    new Map([[70, new Set([key])]]), opts);
  assert.equal(startsOn(without('2035-10-28'), 'Europe/Berlin', '2035-10-28').length, 0,
    'Herbst: Ausnahme am Umstellungstag greift weiter');
  const spring = without('2035-03-24');
  assert.equal(startsOn(spring, 'Europe/Berlin', '2035-03-24').length, 0, 'Fruehjahr wie main: Vortag weg');
  assert.equal(startsOn(spring, 'Europe/Berlin', '2035-03-25').length, 0, 'Fruehjahr wie main: Umstellungstag weg');

  // Importiertes EXDATE: der Parser bringt es mit derselben alten Uhr auf den
  // Tag, also trifft es weiter das gemeinte Vorkommen.
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dst-exdate', 'SUMMARY:Serie',
    'DTSTART;TZID=Europe/Berlin:20340710T013000', 'DTEND;TZID=Europe/Berlin:20340710T023000',
    'RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Berlin:20351028T013000', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const [parsed] = parseICS(ics);
  const master = { id: 71, start_datetime: parsed.dtstart, end_datetime: parsed.dtend,
    recurrence_rule: parsed.rrule, tzid: parsed.tzid, all_day: 0 };
  const imported = expandRecurringEvents([master], '2035-10-20', '2035-11-02',
    new Map([[71, new Set(parsed.exdates)]]), opts);
  assert.equal(startsOn(imported, 'Europe/Berlin', '2035-10-28').length, 0, 'importiertes EXDATE greift');
  assert.equal(startsOn(imported, 'Europe/Berlin', '2035-10-29').length, 1);
});
