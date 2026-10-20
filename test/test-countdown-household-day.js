/**
 * Test: ein Countdown zaehlt auf den Tag der HAUSHALTSZONE herunter, nie auf
 * den der Prozesszone (#1998).
 *
 * Ein lokal angelegter Termin mit Uhrzeit steht als zonenlose Wanduhr des
 * Haushalts in der Zeile (`2035-10-02T23:30`). `eventStartDateKey` las diese
 * Ziffern mit `utcToWall()`, also ueber `new Date()` in der Zone des PROZESSES:
 * im Standard-Container (TZ=UTC) mit Haushalt Europe/Berlin wurde aus 23:30 am
 * 02.10. der 03.10. `test:countdown` sah das nie, weil die Suite TZ fest auf
 * Europe/Berlin setzt - Prozess und Haushalt fielen dort zusammen.
 *
 * Erwartet: zonenlose Ziffern tragen ihren Tag im Datumsteil; ein Instant wird
 * in der Haushaltszone zum Tag. "Heute" kommt als fester `todayKey` herein,
 * die Uhr ist damit eingefroren - nichts hier liest `Date.now()`.
 *
 * Seit dem Restfall von #1998 auch: eine Serie mit eigener Zone (`tzid`) zaehlt
 * nicht ueber ihr Ende hinaus. Der Countdown fragt dieselbe Expansion wie der
 * Kalender, also halten COUNT, UNTIL (auch mit Uhrzeit) und EXDATE dort per
 * Konstruktion. Die Abnahmefaelle stammen aus dem Issue-Kommentar zu #1998.
 *
 * Das Skript faehrt die Datei unter TZ=UTC, Europe/Berlin, Pacific/Auckland und
 * America/Los_Angeles.
 *
 * Ausfuehren: npm run test:countdown-household-day
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { getCountdowns, nextEventDate } = await import('../server/services/countdowns.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');

const BERLIN = 'Europe/Berlin';
const LA = 'America/Los_Angeles';
const ZONE = process.env.TZ;

const userId = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')",
).run().lastInsertRowid;

function setHousehold(zone) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
}

function insertEvent({ start, rule = null, tzid = null }) {
  return db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, recurrence_rule, tzid, created_by, visibility, countdown)
    VALUES ('Abend', ?, 0, ?, ?, ?, 'all', 1)
  `).run(start, rule, tzid, userId).lastInsertRowid;
}

function countdownFor(id, todayKey) {
  const { items } = getCountdowns(db, { userId, todayKey });
  return items.find((item) => item.source === 'event' && item.id === id) ?? null;
}

test(`TZ=${ZONE}: ein Abendtermin zaehlt auf seinen eigenen Tag, Haushalt oestlich von UTC`, () => {
  assert.equal(nextEventDate({ all_day: 0, start_datetime: '2035-10-02T23:30' }, '2035-10-01', null, { tz: BERLIN }),
    '2035-10-02');
});

test(`TZ=${ZONE}: ein Fruehtermin zaehlt auf seinen eigenen Tag, Haushalt westlich von UTC`, () => {
  // Die verschobene Zone: 00:30 in Los Angeles liegt in jeder Prozesszone
  // dieses Laufs (UTC, Berlin, Auckland) noch oder schon auf einem anderen Tag.
  assert.equal(nextEventDate({ all_day: 0, start_datetime: '2035-10-02T00:30' }, '2035-10-01', null, { tz: LA }),
    '2035-10-02');
});

test(`TZ=${ZONE}: ein Instant wird in der Haushaltszone zum Tag`, () => {
  // 22:30Z ist in Berlin (Sommerzeit) 00:30 am Folgetag, in Los Angeles 15:30.
  const ev = { all_day: 0, start_datetime: '2035-10-02T22:30:00Z' };
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: BERLIN }), '2035-10-03');
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: LA }), '2035-10-02');
});

test(`TZ=${ZONE}: eine woechentliche Abendserie springt nicht auf den Folgetag`, () => {
  // Mittwochs 23:30 ab dem 03.10.2035. Am Donnerstag ist das naechste
  // Vorkommen der Mittwoch darauf - nicht "heute".
  const ev = { all_day: 0, start_datetime: '2035-10-03T23:30', recurrence_rule: 'RRULE:FREQ=WEEKLY' };
  assert.equal(nextEventDate(ev, '2035-10-04', null, { tz: BERLIN }), '2035-10-10');
  assert.equal(nextEventDate(ev, '2035-10-03', null, { tz: BERLIN }), '2035-10-03');
});

test(`TZ=${ZONE}: getCountdowns liest die Haushaltszone aus der Datenbank`, () => {
  setHousehold(BERLIN);
  const evening = insertEvent({ start: '2035-10-02T23:30' });
  const item = countdownFor(evening, '2035-10-02');
  assert.ok(item, 'der Abendtermin steht in der Liste');
  assert.equal(item.date, '2035-10-02');
  assert.equal(item.days_until, 0);

  setHousehold(LA);
  const early = insertEvent({ start: '2035-10-02T00:30' });
  const earlyItem = countdownFor(early, '2035-10-01');
  assert.ok(earlyItem, 'der Fruehtermin steht in der Liste');
  assert.equal(earlyItem.date, '2035-10-02');
  assert.equal(earlyItem.days_until, 1);
  db.prepare('UPDATE calendar_events SET countdown = 0').run();
});

test(`TZ=${ZONE}: die Monatsletzten-Frage einer Serie mit tzid haengt nicht an der Prozesszone`, () => {
  // Haushalt = tzid = Los Angeles, also keine zweite Uhr: der Start am 15.
  // um 00:30 liegt nicht auf "letzter Tag des Monats", der erste Termin ist der
  // 31.10. - so zeigt es auch der Kalender. Unter der Prozesszone gelesen lag
  // die Wanduhr der tzid am 14., die Pruefung setzte aus, und der Countdown
  // nannte den 15., an dem nichts stattfindet.
  const ev = {
    all_day: 0, tzid: LA, start_datetime: '2035-10-15T00:30', recurrence_rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
  };
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: LA }), '2035-10-31');
  assert.equal(nextEventDate(ev, '2035-11-01', null, { tz: LA }), '2035-11-30');
});

// ── Restfall #1998: eine zonierte Serie zaehlt nicht ueber ihr Ende hinaus ───
//
// Die Abnahme aus dem Issue-Kommentar, unveraendert bis auf die Helfer: sie
// liefen in test-naive-start-in-tzid.js gegen den Stand von #1996. "Heute" ist
// ueberall ein fester `todayKey`.

/** Wanduhr eines Instants in `zone`, als `YYYY-MM-DD HH:MM`. */
function localOf(iso, zone) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' })
    .format(new Date(iso));
}

/** Eine eingelesene Serie (CalDAV), als Countdown markiert. */
function insertImported({ start, end = null, rule = null, tzid = LA }) {
  return Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid,
      external_source, external_calendar_id, created_by, countdown)
    VALUES ('Import', ?, ?, 0, ?, ?, 'caldav', ?, ?, 1)
  `).run(start, end, rule, tzid, `uid-${start}-${rule}`, userId).lastInsertRowid);
}

test(`TZ=${ZONE}: der Countdown nennt den Tag, den der Kalender zeigt`, () => {
  setHousehold(BERLIN);
  db.prepare('UPDATE calendar_events SET countdown = 0').run();
  const id = insertImported({
    start: '2035-10-02T08:30', end: '2035-10-02T08:45', rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3',
  });
  const shown = expandAndResolveEventRows(db, [db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id)],
    '2035-09-01', '2036-03-01');
  assert.equal(localOf(shown[0].start_datetime, BERLIN), '2035-11-01 07:30', 'Vorbedingung: der Kalender');
  const item = countdownFor(id, '2035-09-01');
  assert.ok(item, 'die Serie steht in der Liste');
  assert.equal(item.date, '2035-11-01');
  db.prepare('UPDATE calendar_events SET countdown = 0').run();
});

const DAILY_LA = { all_day: 0, tzid: LA, start_datetime: '2035-10-02T08:30', recurrence_rule: 'RRULE:FREQ=DAILY' };

test(`TZ=${ZONE}: der Countdown endet an einem UNTIL mit Uhrzeit wie der Kalender`, () => {
  // Taeglich 23:30 Los Angeles; UNTIL ist 02.10. 23:59:59 dort. Das letzte
  // Vorkommen liegt im Haushalt Berlin am 03.10., am 04.10. kommt keines mehr.
  for (const start of ['2035-10-02T06:30:00Z', '2035-10-02T08:30']) {
    const ev = { ...DAILY_LA, start_datetime: start, recurrence_rule: 'RRULE:FREQ=DAILY;UNTIL=20351003T065959Z' };
    const shown = expandRecurringEvents([{ id: 7, ...ev }], '2035-09-01', '2035-12-31', null, { householdZone: BERLIN });
    assert.equal(localOf(shown.at(-1).start_datetime, BERLIN), '2035-10-03 08:30', `Vorbedingung (${start})`);
    assert.equal(nextEventDate(ev, '2035-10-03', null, { tz: BERLIN }), '2035-10-03', start);
    assert.equal(nextEventDate(ev, '2035-10-04', null, { tz: BERLIN }), null, start);
  }
});

test(`TZ=${ZONE}: der Countdown sucht ab dem Ortstag vor heute`, () => {
  // Heute (Berlin) ist der 04.10.; das Vorkommen am 03.10. 23:30 Los Angeles
  // liegt im Haushalt am 04.10. 08:30 und ist das naechste.
  assert.equal(nextEventDate(DAILY_LA, '2035-10-04', null, { tz: BERLIN }), '2035-10-04');
});

test(`TZ=${ZONE}: der Countdown ueberspringt eine Ausnahme in beiden Schluesselformen`, () => {
  // 03.10. 23:30 PDT ist 04.10. 06:30Z: die alte Ausnahme traegt den UTC-Tag
  // 04.10., die neue (#2034, Format A) den Originalstart als Zeitpunkt.
  assert.equal(nextEventDate(DAILY_LA, '2035-10-04', new Set(['2035-10-04']), { tz: BERLIN }), '2035-10-05');
  assert.equal(nextEventDate(DAILY_LA, '2035-10-04', new Set(['2035-10-04T06:30:00Z']), { tz: BERLIN }),
    '2035-10-05');
});

/** Die Haushaltstage aller Vorkommen, die der Kalender ab 2034 zeigt (bis `to`). */
function calendarDays(ev, household, to = '2045-12-31') {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: household, dateStyle: 'short' });
  return expandRecurringEvents([{ id: 8, ...ev }], '2034-01-01', to, null,
    { householdZone: household, maxIterations: 100000 })
    // Zonenlose Ziffern sind Wanduhr des Haushalts: ihr Tag ist der Datumsteil.
    .map((o) => (/(?:Z|[+-]\d{2}:?\d{2})$/.test(o.start_datetime)
      ? day.format(new Date(o.start_datetime))
      : o.start_datetime.slice(0, 10)));
}

/** Der naechste Tag, den der Kalender zeigt (Haushaltstag), oder null. */
function calendarNextDay(ev, todayKey, household, days = calendarDays(ev, household)) {
  return days.find((day) => day >= todayKey) ?? null;
}

test(`TZ=${ZONE}: der Countdown zaehlt COUNT wie der Kalender, auch nach dem 28.`, () => {
  // 01.01. 00:30 Berlin ist der 31.12. in Los Angeles: ein Monatsanker nach
  // dem 28. Fuenf Vorkommen, das letzte im Haushalt am 01.05.
  const ev = { all_day: 0, tzid: LA, start_datetime: '2035-01-01T00:30', recurrence_rule: 'RRULE:FREQ=MONTHLY;COUNT=5' };
  assert.equal(calendarNextDay(ev, '2035-10-02', BERLIN), null, 'Vorbedingung: der Kalender');
  assert.equal(nextEventDate(ev, '2035-10-02', null, { tz: BERLIN }), null);
});

const TODAYS = ['2035-01-01', '2035-03-15', '2035-10-01', '2035-10-20', '2035-12-31', '2036-03-01', '2040-02-28', '2044-03-01'];

test(`TZ=${ZONE}: Countdown und Kalender nennen denselben Tag (Monatsletzter, 29.2., woechentlich, mit COUNT)`, () => {
  const cases = [
    { start: '2035-01-01T00:30', rule: 'RRULE:FREQ=MONTHLY;COUNT=5' },
    { start: '2035-01-15T05:30', rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4' },
    { start: '2035-11-01T05:30', rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3' },
    { start: '2036-03-01T07:30', rule: 'RRULE:FREQ=YEARLY;COUNT=3' },
    { start: '2035-10-02T08:30', rule: 'RRULE:FREQ=WEEKLY;COUNT=4' },
    { start: '2035-10-02T08:30', rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=5' },
  ];
  for (const c of cases) {
    const ev = { all_day: 0, tzid: LA, start_datetime: c.start, recurrence_rule: c.rule };
    for (const today of TODAYS) {
      assert.equal(nextEventDate(ev, today, null, { tz: BERLIN }), calendarNextDay(ev, today, BERLIN),
        `${c.start} ${c.rule} heute ${today}`);
    }
  }
});

test(`TZ=${ZONE}: Countdown und Kalender nennen denselben Tag auch ohne COUNT`, () => {
  // Ohne COUNT setzt der Countdown die Expansion nahe an heute an, statt ab
  // DTSTART zu zaehlen. Der Sprung darf kein Vorkommen verlieren und keines
  // erfinden: gegengerechnet gegen die Expansion ab DTSTART, mit und ohne
  // eigene Zone, ueber Monatsenden, Intervalle und Wochentagsregeln.
  const rules = [
    'RRULE:FREQ=DAILY;INTERVAL=10',
    'RRULE:FREQ=WEEKLY;INTERVAL=2',
    'RRULE:FREQ=MONTHLY',
    'RRULE:FREQ=MONTHLY;INTERVAL=5',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=20',
    'RRULE:FREQ=MONTHLY;BYDAY=2MO',
    'RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR',
    'RRULE:FREQ=YEARLY;INTERVAL=2',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA',
    'RRULE:FREQ=DAILY;BYDAY=SA,SU',
    'RRULE:FREQ=WEEKLY;UNTIL=20380101T065959Z',
    'RRULE:FREQ=MONTHLY;UNTIL=20370301',
  ];
  const starts = ['2035-01-10T05:30', '2035-01-31T00:30', '2035-02-01T08:30'];
  const todays = ['2035-01-01', '2035-03-15', '2035-10-20', '2036-03-01', '2037-02-28', '2038-03-01'];
  const WINDOW_END = '2038-12-31';
  for (const rule of rules) {
    for (const start of starts) {
      for (const tzid of [LA, null]) {
        const ev = { all_day: 0, tzid, start_datetime: start, recurrence_rule: rule };
        const days = calendarDays(ev, BERLIN, WINDOW_END);
        for (const today of todays) {
          const got = nextEventDate(ev, today, null, { tz: BERLIN });
          const want = calendarNextDay(ev, today, BERLIN, days);
          // Hinter dem Fenster der Gegenrechnung weiss der Kalender nichts; dort
          // darf der Countdown nur einen Tag nennen, der wirklich dahinter liegt.
          if (want === null && got !== null) {
            assert.ok(got > WINDOW_END, `${start} ${rule} tzid ${tzid} heute ${today}: ${got}`);
            continue;
          }
          assert.equal(got, want, `${start} ${rule} tzid ${tzid} heute ${today}`);
        }
      }
    }
  }
});

test(`TZ=${ZONE}: eine lange laufende Serie zaehlt ab heute, nicht ab ihrem Anfang`, () => {
  // Taeglich seit 1700, ohne Ende: von dort bis 2035 sind es mehr Schritte,
  // als die Expansion je macht. Der Countdown setzt deshalb nahe an heute an.
  const ev = { all_day: 0, tzid: LA, start_datetime: '1700-01-01T20:30:00Z', recurrence_rule: 'RRULE:FREQ=DAILY' };
  assert.equal(nextEventDate(ev, '2035-10-04', null, { tz: BERLIN }), '2035-10-04');
});

test(`TZ=${ZONE}: das naechste Vorkommen darf weit weg liegen`, () => {
  // Keine feste Obergrenze: alle 40 Jahre, das naechste Mal 2075.
  const ev = { all_day: 0, tzid: LA, start_datetime: '2035-10-02T08:30', recurrence_rule: 'RRULE:FREQ=YEARLY;INTERVAL=40' };
  assert.equal(nextEventDate(ev, '2036-01-01', null, { tz: BERLIN }), '2075-10-02');
});
