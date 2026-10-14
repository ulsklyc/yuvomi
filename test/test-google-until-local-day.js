/**
 * Test: eine getimte Serie mit reinem Datum als Ende endet bei Google an
 * demselben Vorkommen wie in Yuvomi (#1974).
 *
 * Yuvomi liest `UNTIL=20351010` an einer getimten Serie als TAG: das letzte
 * Vorkommen ist das am 10. Oktober, in der Zone, in der die Serie expandiert
 * wird (`services/calendar-events.js`, Tagesgatter in `nextOccurrence`). Google
 * verlangt bei `start.dateTime` ein UNTIL in UTC, und hinaus ging bisher
 * `UNTIL=20351010T235959Z` - das Tagesende in UTC, nicht in der Zone der Serie.
 * Oestlich von UTC zeigte Google damit ein Vorkommen mehr (Europe/Berlin, 00:30
 * am 11. Oktober ist 22:30Z am 10.), westlich eines weniger (Los Angeles, 23:30
 * am 10. Oktober ist 06:30Z am 11.).
 *
 * Gemessen wird nicht die Schreibweise, sondern die Folge: aus dem gebauten
 * Request wird Googles Vorkommensmenge nachgerechnet - Wanduhrzeit in der
 * mitgesendeten `timeZone`, jedes Vorkommen bis einschliesslich des UNTIL-
 * Zeitpunkts (RFC 5545) - und mit der Expansion von Yuvomi verglichen. Die
 * Umrechnung Wanduhr -> Zeitpunkt hat der Test selbst (`Intl`, nicht
 * `utils/timezone.js`), damit Fix und Messung nicht durch denselben Leser gehen.
 *
 * Die Haushaltszone ist hier ein Parameter je Fall; das Skript faehrt die Datei
 * zusaetzlich unter zwei Prozesszonen (UTC, Europe/Berlin), damit ein Lesen der
 * Maschinenzone statt der gesendeten auffaellt.
 *
 * Ausfuehren: npm run test:google-until-local-day
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { __test } = await import('../server/services/google-calendar.js');
const { localEventToGoogle, outboundTimeZone } = __test;
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

// ── Unabhaengige Uhr ────────────────────────────────────────────────────────

/** Versatz einer Zone zu einem Zeitpunkt in Minuten, ueber `Intl` gelesen. */
function offsetMinutes(ms, zone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
  if (!m) return 0; // "GMT" allein
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Wanduhrzeit `YYYY-MM-DDTHH:MM[:SS]` einer Zone -> ms seit Epoch. Gibt es die
 * Ortszeit zweimal (Uhr zurueckgestellt), der ERSTE der beiden Zeitpunkte -
 * so liest RFC 5545 eine doppelte Ortszeit.
 */
function wallToMs(wall, zone) {
  const naive = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  const offsets = new Set([-1, 0, 1].map((days) => offsetMinutes(naive + days * 86400000, zone)));
  const fits = [...offsets].map((o) => naive - o * 60000).filter((ms) => offsetMinutes(ms, zone) * 60000 === naive - ms);
  if (fits.length) return Math.min(...fits);
  // Fruehjahrsluecke: die Ortszeit gibt es nicht; wie zuvor der Naeherungswert.
  return naive - offsetMinutes(naive - offsetMinutes(naive, zone) * 60000, zone) * 60000;
}

/** `YYYYMMDDTHHMMSSZ` -> ms. */
function utcStampToMs(stamp) {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(stamp);
  assert.ok(m, `UNTIL ist kein UTC-Zeitpunkt: ${stamp}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const addDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Googles Vorkommen einer TAEGLICHEN Serie aus dem Request: jeder Tag ab dem
 * Start, Wanduhrzeit in `start.timeZone`, bis einschliesslich UNTIL. Liefert die
 * lokalen Tage.
 */
function googleDays(body) {
  const rule = body.recurrence[0].replace(/^RRULE:/, '');
  assert.match(rule, /(^|;)FREQ=DAILY(;|$)/, 'die Nachrechnung kennt nur taegliche Serien');
  const until = /(?:^|;)UNTIL=([^;]+)/.exec(rule)[1];
  const days = [];
  if (body.start.date) {
    assert.match(until, /^\d{8}$/, 'ganztaegig muss UNTIL ein Datum sein');
    const last = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
    for (let day = body.start.date; day <= last; day = addDay(day)) days.push(day);
    return days;
  }
  const untilMs = utcStampToMs(until);
  const [startDay, startTime] = body.start.dateTime.split('T');
  for (let day = startDay, i = 0; i < 400; day = addDay(day), i++) {
    if (wallToMs(`${day}T${startTime}`, body.start.timeZone) > untilMs) break;
    days.push(day);
  }
  return days;
}

/** Yuvomis Vorkommen derselben Zeile, als lokale Tage. */
function yuvomiDays(event) {
  return expandRecurringEvents([{ id: 1, ...event }], '2020-01-01', '2036-12-31')
    .map((occ) => String(occ.start_datetime).slice(0, 10));
}

function setHousehold(zone) {
  if (zone === null) {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    return;
  }
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

const timed = (time, until, startDay = '2035-10-01') => ({
  title: 'Serie', all_day: 0,
  start_datetime: `${startDay}T${time}`, end_datetime: `${startDay}T${time === '23:30' ? '23:45' : time.replace(/:(\d\d)$/, ':59')}`,
  recurrence_rule: `FREQ=DAILY;UNTIL=${until}`,
});

// ── Die Faelle ──────────────────────────────────────────────────────────────

const ZONES = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Chatham'];
const TIMES = ['00:30', '12:00', '23:30'];

for (const zone of ZONES) {
  for (const time of TIMES) {
    test(`${zone}, taeglich ${time}, UNTIL=20351010: Google endet am selben Vorkommen wie Yuvomi`, () => {
      const event = timed(time, '20351010');
      const body = localEventToGoogle(event, {}, zone);
      assert.equal(body.start.timeZone, zone);
      const yuvomi = yuvomiDays(event);
      assert.equal(yuvomi.at(-1), '2035-10-10', 'Vorbedingung: Yuvomi endet am UNTIL-Tag');
      assert.deepEqual(googleDays(body), yuvomi);
    });
  }
}

test('die beiden Faelle aus dem Ticket sind andere Vorkommen als in UTC', () => {
  // Ohne diese Zusicherung koennte die Matrix oben gruen sein, weil sie die
  // Grenze nie trifft.
  const berlin = localEventToGoogle(timed('00:30', '20351010'), {}, 'Europe/Berlin');
  assert.equal(berlin.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  const la = localEventToGoogle(timed('23:30', '20351010'), {}, 'America/Los_Angeles');
  assert.equal(la.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351011T065959Z');
  const utc = localEventToGoogle(timed('00:30', '20351010'), {}, 'UTC');
  assert.equal(utc.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T235959Z');
});

test('Tagesgrenze am Tag der Zeitumstellung: der Versatz des UNTIL-Tags zaehlt', () => {
  // Europe/Berlin stellt 2035 am 28. Oktober zurueck. Am 27. endet der Tag in
  // Sommerzeit (21:59:59Z), am 28. in Winterzeit (22:59:59Z).
  for (const [until, expected] of [['20351027', '20351027T215959Z'], ['20351028', '20351028T225959Z']]) {
    const event = timed('23:30', until, '2035-10-20');
    const body = localEventToGoogle(event, {}, 'Europe/Berlin');
    assert.equal(body.recurrence[0], `RRULE:FREQ=DAILY;UNTIL=${expected}`);
    assert.deepEqual(googleDays(body), yuvomiDays(event));
  }
  // Los Angeles stellt 2035 am 4. November zurueck: PDT bis dahin, danach PST.
  for (const [until, expected] of [['20351103', '20351104T065959Z'], ['20351104', '20351105T075959Z']]) {
    const event = timed('00:30', until, '2035-10-28');
    const body = localEventToGoogle(event, {}, 'America/Los_Angeles');
    assert.equal(body.recurrence[0], `RRULE:FREQ=DAILY;UNTIL=${expected}`);
    assert.deepEqual(googleDays(body), yuvomiDays(event));
  }
});

test('die erste Stunde des Folgetags gibt es zweimal: die Grenze liegt vor der ersten', () => {
  // Asia/Amman stellte am 29.10.2021 um 01:00 (+03) auf 00:00 (+02) zurueck:
  // 00:00 bis 00:59 des 29. gibt es zweimal. Der 28. endet beim ERSTEN 00:00,
  // 21:00Z - und das Vorkommen um 00:30 im ersten Durchgang (21:30Z) gehoert
  // schon zum 29. (Review-Befund an #1975).
  const event = timed('00:30', '20211028', '2021-10-20');
  const body = localEventToGoogle(event, {}, 'Asia/Amman');
  assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20211028T205959Z');
  assert.deepEqual(googleDays(body), yuvomiDays(event));
  assert.equal(googleDays(body).at(-1), '2021-10-28');
});

test('UNTIL folgt der gesendeten Zone, nicht der Zone des Prozesses', () => {
  // Haushaltszone gesetzt: sie geht als timeZone hinaus, und das UNTIL folgt ihr.
  setHousehold('Europe/Berlin');
  try {
    const zone = outboundTimeZone('America/Los_Angeles');
    assert.equal(zone, 'Europe/Berlin');
    const body = localEventToGoogle(timed('00:30', '20351010'), {}, zone);
    assert.equal(body.start.timeZone, 'Europe/Berlin');
    assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
    // Ohne dritten Parameter gilt dieselbe Zone (Standardwert).
    assert.equal(localEventToGoogle(timed('00:30', '20351010')).recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  } finally {
    setHousehold(null);
  }
  // Ohne Haushaltszone: die Zone des Zielkalenders.
  const zone = outboundTimeZone('America/Los_Angeles');
  assert.equal(zone, 'America/Los_Angeles');
  const body = localEventToGoogle(timed('23:30', '20351010'), {}, zone);
  assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351011T065959Z');
});

test('ganztaegig: UNTIL bleibt ein Datum und endet am selben Tag wie in Yuvomi', () => {
  for (const zone of ZONES) {
    for (const until of ['20351010', '20351010T235959Z', '20351010T215959Z']) {
      const event = {
        title: 'Ganztags', all_day: 1, start_datetime: '2035-10-01', end_datetime: '2035-10-01',
        recurrence_rule: `FREQ=DAILY;UNTIL=${until}`,
      };
      const body = localEventToGoogle(event, {}, zone);
      assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010', `${zone} ${until}`);
      assert.deepEqual(googleDays(body), yuvomiDays(event), `${zone} ${until}`);
    }
  }
});

test('ein UNTIL mit Uhrzeit bleibt unangetastet', () => {
  for (const zone of ZONES) {
    const body = localEventToGoogle(timed('00:30', '20351010T120000Z'), {}, zone);
    assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T120000Z');
  }
});
