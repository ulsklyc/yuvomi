/**
 * Test: das Serienende aus dem Formular endet bei jedem Anbieter an demselben
 * Vorkommen wie in Yuvomi (#1974, Rest nach #1975).
 *
 * DER WEG, DER GEMESSEN WIRD. Das Formular (`public/rrule-ui.js`) baut die
 * Regel, die Zeile wird so expandiert, wie Yuvomi sie zeigt, und dieselbe Zeile
 * geht ueber jeden ausgehenden Weg hinaus: Google, CalDAV-Neuanlage,
 * CalDAV-Aenderung, iCloud-Neuanlage und der ICS-Feed. Aus jedem gebauten
 * Objekt wird die Vorkommensmenge des Empfaengers nachgerechnet - Wanduhrzeit in
 * der gesendeten Zone, jedes Vorkommen bis einschliesslich UNTIL (RFC 5545) -
 * und mit Yuvomis Expansion verglichen.
 *
 * Bis hierher schrieb das Formular `UNTIL=<datum>T235959Z`, das Ende des
 * UTC-Tags. Yuvomi liest an einer zonenlosen Serie nur den Tag; die Empfaenger
 * lesen den Zeitpunkt. Oestlich von UTC (Berlin, 00:30) zeigten sie damit ein
 * Vorkommen mehr, westlich (Los Angeles, 23:30) eines weniger.
 *
 * RFC 5545 §3.3.10: der Werttyp von UNTIL folgt DTSTART - ein Datum bei
 * VALUE=DATE, sonst ein Zeitpunkt in UTC, sobald DTSTART eine Zone traegt.
 * Auch das wird je Weg geprueft: ein reines Datum an einem getimten DTSTART
 * waere bei CalDAV/iCloud ein ungueltiges Objekt.
 *
 * Dazu der Rueckweg ins Formular: eine Regel, die ein Anbieter mit dem
 * Tagesende als Zeitpunkt zuruecklieferte, zeigt westlich von UTC sonst den
 * Folgetag als Ende - und wer dann die Wiederholung anfasst, verlaengert die
 * Serie um einen Tag.
 *
 * Und (b): ein UNTIL mit Uhrzeit ohne Zone ist eine Ortszeit und ging zu
 * Google mit angehaengtem `Z` hinaus.
 *
 * Die Umrechnung Wanduhr -> Zeitpunkt hat der Test selbst (`Intl`), damit Fix
 * und Messung nicht durch denselben Leser gehen. Das Skript faehrt die Datei
 * unter zwei Prozesszonen (UTC, Europe/Berlin).
 *
 * Ausfuehren: npm run test:series-until-local-day
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.DB_PATH = ':memory:';
// calendar.js (Verdrahtungstest unten) greift beim Laden nach window.yuvomi.
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = globalThis.window.yuvomi ?? { showToast() {} };

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { buildRRule, parseRRule, renderRRuleFields, getRRuleValues, describeRRule } = await import('../public/rrule-ui.js');
const { __test: google } = await import('../server/services/google-calendar.js');
const { __test: caldav } = await import('../server/services/caldav-sync.js');
const { __test: apple } = await import('../server/services/apple-calendar.js');
const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
const { __test: feed } = await import('../server/services/ics-export.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
// Ueber den Loader: calendar.js bekommt den rrule-ui-Stub, dessen Haken
// (__renderRRuleFields, __recurrenceRow) hier die ECHTEN Funktionen bedienen.
const { __test: calendarPage } = await import('../public/pages/calendar.js');
const realRRule = await import('../public/rrule-ui.js');

// ── Unabhaengige Uhr ────────────────────────────────────────────────────────

function offsetMinutes(ms, zone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Wanduhrzeit einer Zone -> ms; bei doppelter Ortszeit der erste Zeitpunkt. */
function wallToMs(wall, zone) {
  const naive = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  const offsets = new Set([-1, 0, 1].map((days) => offsetMinutes(naive + days * 86400000, zone)));
  const fits = [...offsets].map((o) => naive - o * 60000).filter((ms) => offsetMinutes(ms, zone) * 60000 === naive - ms);
  if (fits.length) return Math.min(...fits);
  return naive - offsetMinutes(naive - offsetMinutes(naive, zone) * 60000, zone) * 60000;
}

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
const dashed = (d8) => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
const wallOf = (d8t) => `${dashed(d8t.slice(0, 8))}T${d8t.slice(9, 11)}:${d8t.slice(11, 13)}:${d8t.slice(13, 15)}`;

/** Lokale Tage einer TAEGLICHEN Serie: Start (Tag, Uhrzeit, Zone) bis UNTIL-Zeitpunkt. */
function dailyDays(startDay, startTime, zone, untilMs) {
  const days = [];
  for (let day = startDay, i = 0; i < 400; day = addDay(day), i++) {
    if (wallToMs(`${day}T${startTime}`, zone) > untilMs) break;
    days.push(day);
  }
  return days;
}

function googleDays(body) {
  const rule = body.recurrence[0].replace(/^RRULE:/, '');
  const until = /(?:^|;)UNTIL=([^;]+)/.exec(rule)[1];
  if (body.start.date) {
    assert.match(until, /^\d{8}$/, 'ganztaegig muss UNTIL ein Datum sein');
    const days = [];
    for (let day = body.start.date; day <= dashed(until); day = addDay(day)) days.push(day);
    return days;
  }
  const [startDay, startTime] = body.start.dateTime.split('T');
  return dailyDays(startDay, startTime, body.start.timeZone, utcStampToMs(until));
}

/**
 * Die Vorkommen eines ICS-Objekts, wie ein CalDAV-Server sie liest, und die
 * RFC-Pruefung des UNTIL-Werttyps gegen DTSTART.
 */
function icsDays(dtstartLine, rruleValue) {
  const until = /(?:^|;)UNTIL=([^;]+)/.exec(rruleValue.replace(/^RRULE:/, ''))[1];
  const dateOnly = /^DTSTART;VALUE=DATE:(\d{8})$/.exec(dtstartLine);
  if (dateOnly) {
    assert.match(until, /^\d{8}$/, `RFC 5545: DTSTART ist ein Datum, UNTIL muss eins sein (${until})`);
    const days = [];
    for (let day = dashed(dateOnly[1]); day <= dashed(until); day = addDay(day)) days.push(day);
    return days;
  }
  const m = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/.exec(dtstartLine);
  assert.ok(m, `unbekanntes DTSTART: ${dtstartLine}`);
  assert.match(until, /^\d{8}T\d{6}Z$/,
    `RFC 5545: DTSTART mit Zone verlangt UNTIL in UTC, nicht ${until} (${dtstartLine})`);
  const zone = m[1] || 'UTC';
  const wall = wallOf(m[2]);
  return dailyDays(wall.slice(0, 10), wall.slice(11), zone, utcStampToMs(until));
}

function lineOf(ics, name) {
  // Nur im VEVENT: ein VTIMEZONE-Block traegt eigene DTSTART-Zeilen (1970).
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const vevent = unfolded.slice(unfolded.indexOf('BEGIN:VEVENT'));
  return vevent.split(/\r?\n/).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

/** Yuvomis Vorkommen derselben Zeile, als Tage. */
function yuvomiDays(event) {
  return expandRecurringEvents([{ id: 1, ...event }], '2020-01-01', '2036-12-31')
    .map((occ) => String(occ.start_datetime).slice(0, 10));
}

function setHousehold(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

/** Alle ausgehenden Wege derselben Zeile: Name -> Tage beim Empfaenger. */
function providerDays(event, zone) {
  const out = {};
  out.google = googleDays(google.localEventToGoogle(event, {}, zone));
  const viaIcs = (ics) => icsDays(lineOf(ics, 'DTSTART'), lineOf(ics, 'RRULE'));
  out.caldavCreate = viaIcs(caldav.buildCalDAVICS(event, zone));
  out.icloudCreate = viaIcs(apple.buildICS(event, zone));
  const fields = icsFieldsForEvent(event, zone).fields;
  out.caldavUpdate = icsDays(`DTSTART${fields.DTSTART.params}:${fields.DTSTART.value}`, fields.RRULE);
  out.feed = viaIcs(feed.buildVEvent(event, '20350101T000000Z', false, zone).join('\r\n'));
  return out;
}

// ── (a) Das Formular schreibt das Ende eines Tages ──────────────────────────

const ZONES = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Chatham'];
const TIMES = ['00:30', '12:00', '23:30'];

for (const zone of ZONES) {
  for (const time of TIMES) {
    test(`${zone}, taeglich ${time}, Ende am 10.10. im Formular: jeder Anbieter endet am selben Vorkommen wie Yuvomi`, () => {
      setHousehold(zone);
      const rule = buildRRule({ freq: 'DAILY', interval: 1, byday: [], until: '2035-10-10' });
      const event = {
        title: 'Serie', all_day: 0, tzid: null,
        start_datetime: `2035-10-01T${time}`, end_datetime: `2035-10-01T${time === '23:30' ? '23:45' : time.replace(/:(\d\d)$/, ':59')}`,
        recurrence_rule: rule,
      };
      const yuvomi = yuvomiDays(event);
      assert.equal(yuvomi.at(-1), '2035-10-10', 'Vorbedingung: Yuvomi endet am eingegebenen Tag');
      for (const [weg, days] of Object.entries(providerDays(event, zone))) {
        assert.deepEqual(days, yuvomi, `${weg}: ${rule}`);
      }
    });
  }
}

test('ganztaegig, Ende am 10.10. im Formular: jeder Anbieter endet am 10.10., UNTIL ist ein Datum', () => {
  for (const zone of ZONES) {
    setHousehold(zone);
    const rule = buildRRule({ freq: 'DAILY', interval: 1, byday: [], until: '2035-10-10' });
    const event = {
      title: 'Ganztags', all_day: 1, tzid: null,
      start_datetime: '2035-10-01', end_datetime: '2035-10-01', recurrence_rule: rule,
    };
    const yuvomi = yuvomiDays(event);
    assert.equal(yuvomi.at(-1), '2035-10-10');
    for (const [weg, days] of Object.entries(providerDays(event, zone))) {
      assert.deepEqual(days, yuvomi, `${zone} ${weg}: ${rule}`);
    }
  }
});

test('eine Serie mit eigener Zone und Zeitpunkt-Start: das Formularende ist der Ortstag dieser Zone', () => {
  // Eingelesene Serie aus Los Angeles (23:30 Ortszeit = 06:30Z am Folgetag),
  // im Formular mit neuem Ende versehen. Yuvomi expandiert sie in ihrer Zone.
  setHousehold('Europe/Berlin');
  const rule = buildRRule({ freq: 'DAILY', interval: 1, byday: [], until: '2035-10-10' });
  const event = {
    title: 'LA', all_day: 0, tzid: 'America/Los_Angeles',
    start_datetime: '2035-10-02T06:30:00Z', end_datetime: '2035-10-02T06:45:00Z', recurrence_rule: rule,
  };
  const occ = expandRecurringEvents([{ id: 1, ...event }], '2020-01-01', '2036-12-31');
  const lastLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(occ.at(-1).start_datetime));
  assert.equal(lastLocal, '2035-10-10', 'Yuvomi endet am 10.10. Ortszeit');
  const fields = icsFieldsForEvent(event, 'Europe/Berlin').fields;
  const days = icsDays(`DTSTART${fields.DTSTART.params}:${fields.DTSTART.value}`, fields.RRULE);
  assert.equal(days.at(-1), '2035-10-10', `CalDAV: ${fields.RRULE}`);
  assert.equal(days.length, occ.length);
});

test('die Faelle aus dem Ticket: das Formular schreibt kein UTC-Tagesende mehr', () => {
  const rule = buildRRule({ freq: 'DAILY', interval: 1, byday: [], until: '2035-10-10' });
  assert.equal(rule, 'FREQ=DAILY;UNTIL=20351010');
  setHousehold('Europe/Berlin');
  const berlin = { title: 'B', all_day: 0, tzid: null, start_datetime: '2035-10-01T00:30', end_datetime: '2035-10-01T00:59', recurrence_rule: rule };
  assert.equal(lineOf(caldav.buildCalDAVICS(berlin, 'Europe/Berlin'), 'RRULE'), 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  setHousehold('America/Los_Angeles');
  const la = { ...berlin, start_datetime: '2035-10-01T23:30', end_datetime: '2035-10-01T23:45' };
  assert.equal(lineOf(apple.buildICS(la, 'America/Los_Angeles'), 'RRULE'), 'RRULE:FREQ=DAILY;UNTIL=20351011T065959Z');
});

test('eine eingelesene Regel ohne reines Datum geht Wort fuer Wort hinaus (#756)', () => {
  setHousehold('Europe/Berlin');
  for (const rule of ['RRULE:FREQ=DAILY;UNTIL=20351010T120000Z', 'FREQ=WEEKLY;BYDAY=MO;WKST=SU', 'RRULE:FREQ=DAILY;COUNT=3']) {
    const event = { title: 'X', all_day: 0, tzid: 'Europe/Berlin', start_datetime: '2035-10-01T08:00:00Z', end_datetime: '2035-10-01T09:00:00Z', recurrence_rule: rule };
    assert.equal(icsFieldsForEvent(event, 'Europe/Berlin').fields.RRULE, rule);
    const bare = rule.replace(/^RRULE:/, '');
    assert.equal(lineOf(caldav.buildCalDAVICS(event, 'Europe/Berlin'), 'RRULE'), `RRULE:${bare}`);
  }
});

// ── Rueckweg ins Formular ───────────────────────────────────────────────────

function formRoot(html) {
  const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const decode = (s) => String(s).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  const values = new Map();
  for (const tag of html.match(/<(input|select|yuvomi-datepicker)\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'id');
    if (id) values.set(`#${id}`, decode(attr(tag, 'value') ?? ''));
  }
  for (const [, id, body] of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = /<option value="([^"]*)"[^>]*\bselected\b/.exec(body);
    values.set(`#${id}`, selected ? selected[1] : (/<option value="([^"]*)"/.exec(body)?.[1] ?? ''));
  }
  return {
    querySelector: (sel) => (values.has(sel) ? { value: values.get(sel), checked: false } : null),
    querySelectorAll: () => [],
    _set: (sel, v) => values.set(sel, v),
  };
}

test('Rueckweg: das Tagesende eines Anbieters zeigt im Formular den Ortstag der Serie', () => {
  // So kommt eine in Los Angeles am 10.10. endende Serie von Google oder einem
  // CalDAV-Server zurueck: das Ende des Ortstags als Zeitpunkt in UTC.
  const series = { tzid: 'America/Los_Angeles', start: '2035-10-02T06:30:00Z' };
  const rule = 'FREQ=DAILY;UNTIL=20351011T065959Z';
  const opts = { allowCount: true, seriesZone: series.tzid, seriesStart: series.start };
  assert.equal(parseRRule(rule, opts).until, '2035-10-10');
  const html = renderRRuleFields('event', rule, opts);
  assert.match(html, /id="event-rrule-until"\s+value="2035-10-10"/, 'das Formular zeigt den 10.10.');
  assert.match(describeRRule(rule, opts), /10/);
  assert.doesNotMatch(describeRRule(rule, opts), /11/);

  // Unveraendert gespeichert: die Regel bleibt im Wortlaut.
  assert.equal(getRRuleValues(formRoot(html), 'event').recurrence_rule, rule);
  // Die Wiederholung angefasst: das Ende bleibt der 10.10.
  const root = formRoot(html);
  root._set('#event-rrule-interval', '2');
  assert.equal(getRRuleValues(root, 'event').recurrence_rule, 'FREQ=DAILY;INTERVAL=2;UNTIL=20351010');
});

test('Rueckweg: ein Ende vor der Startzeit am Endtag zeigt den Vortag (Schnitt "ab hier")', () => {
  // Open-Xchange schneidet eine Serie um 17:00 Berlin mit dem Ende eine
  // Sekunde vor dem Start am Schnitttag (#1269): das letzte Vorkommen ist der Vortag.
  const opts = { seriesZone: 'Europe/Berlin', seriesStart: '2026-09-01T15:00:00Z' };
  assert.equal(parseRRule('FREQ=DAILY;UNTIL=20260918T145959Z', opts).until, '2026-09-17');
  // Eine Ortszeit ohne Zone wird genauso gelesen.
  assert.equal(parseRRule('FREQ=DAILY;UNTIL=20260918T165959', opts).until, '2026-09-17');
});

test('Rueckweg: eine zonenlose Serie liest wie der Server nur den Tag', () => {
  // Bestandsregeln aus dem Formular (`T235959Z`) an einer Serie ohne Zone:
  // Yuvomi expandiert sie am Tag, also zeigt das Formular den Tag.
  for (const opts of [{}, { seriesZone: null, seriesStart: '2035-10-01T00:30' }]) {
    assert.equal(parseRRule('FREQ=DAILY;UNTIL=20351010T235959Z', opts).until, '2035-10-10');
    assert.equal(parseRRule('FREQ=DAILY;UNTIL=20351010', opts).until, '2035-10-10');
  }
});

// ── (b) Ortszeit ohne Zone ──────────────────────────────────────────────────

test('(b) ein UNTIL mit Uhrzeit ohne Zone geht als Ortszeit der Serie zu Google, nicht als UTC', () => {
  setHousehold('America/Los_Angeles');
  const event = {
    title: 'Floating', all_day: 0, tzid: 'America/Los_Angeles',
    start_datetime: '2035-10-01T21:30:00Z', end_datetime: '2035-10-01T22:00:00Z',
    recurrence_rule: 'RRULE:FREQ=DAILY;UNTIL=20351010T143000',
  };
  const body = google.localEventToGoogle(event, {}, 'America/Los_Angeles');
  assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T213000Z');
  const yuvomi = expandRecurringEvents([{ id: 1, ...event }], '2020-01-01', '2036-12-31');
  assert.equal(yuvomi.length, 10, 'Vorbedingung: Yuvomi zaehlt den 10.10. mit');
  assert.equal(googleDays({ ...body, start: { dateTime: '2035-10-01T14:30:00', timeZone: 'America/Los_Angeles' } }).length, 10);
});

test('(b) die Ortszeit wird in der Zone der Serie gelesen, auch wenn Google eine andere bekommt', () => {
  const event = {
    title: 'Floating', all_day: 0, tzid: 'Europe/Berlin',
    start_datetime: '2035-10-01T07:00:00Z', end_datetime: '2035-10-01T08:00:00Z',
    recurrence_rule: 'FREQ=DAILY;UNTIL=20351010T090000',
  };
  const body = google.localEventToGoogle(event, {}, 'America/New_York');
  assert.equal(body.recurrence[0], 'RRULE:FREQ=DAILY;UNTIL=20351010T070000Z');
});

// ── Review zu #1989 ─────────────────────────────────────────────────────────

/**
 * Googles Vorkommen einer taeglichen Serie, auch wenn `start.dateTime` einen
 * Zeitpunkt traegt: Google nimmt dessen Wanduhrzeit in `start.timeZone` und
 * wiederholt sie dort.
 */
function googleCount(body) {
  const zone = body.start.timeZone;
  const rule = body.recurrence[0].replace(/^RRULE:/, '');
  const untilMs = utcStampToMs(/(?:^|;)UNTIL=([^;]+)/.exec(rule)[1]);
  const wall = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(body.start.dateTime)).replace(' ', 'T');
  return dailyDays(wall.slice(0, 10), wall.slice(11), zone, untilMs).length;
}

test('Review 1: ein Datums-UNTIL einer Serie mit eigener Zone endet bei Google am Ortstag DIESER Zone', () => {
  // Haushalt Berlin, Serie aus Los Angeles: Google bekommt timeZone Berlin,
  // Yuvomi expandiert in Los Angeles.
  setHousehold('Europe/Berlin');
  const event = {
    title: 'LA', all_day: 0, tzid: 'America/Los_Angeles',
    start_datetime: '2035-10-02T06:30:00Z', end_datetime: '2035-10-02T06:45:00Z',
    recurrence_rule: 'FREQ=DAILY;UNTIL=20351010',
  };
  const yuvomi = expandRecurringEvents([{ id: 1, ...event }], '2020-01-01', '2036-12-31');
  assert.equal(yuvomi.length, 10, 'Vorbedingung: Yuvomi zeigt 1. bis 10.10. Ortszeit');
  const body = google.localEventToGoogle(event, {}, google.outboundTimeZone(null));
  assert.equal(body.start.timeZone, 'Europe/Berlin');
  assert.equal(googleCount(body), 10, body.recurrence[0]);
});

test('Review 2: ein UTC-UNTIL an einem Zeitpunkt-Start ohne Zone liest das Formular wie der Server in UTC', () => {
  const event = {
    title: 'Z', all_day: 0, tzid: null,
    start_datetime: '2026-09-10T15:00:00Z', end_datetime: '2026-09-10T16:00:00Z',
    recurrence_rule: 'FREQ=DAILY;UNTIL=20260918T145959Z',
  };
  const last = expandRecurringEvents([{ id: 1, ...event }], '2026-01-01', '2026-12-31').at(-1);
  assert.equal(String(last.start_datetime).slice(0, 10), '2026-09-17', 'Vorbedingung: der Server endet am 17.');
  const opts = { seriesZone: null, seriesStart: event.start_datetime };
  assert.equal(parseRRule(event.recurrence_rule, opts).until, '2026-09-17');
  // Eine Ortszeit ohne Zone hat ohne Serienzone keinen Zeitpunkt: der Tag.
  assert.equal(parseRRule('FREQ=DAILY;UNTIL=20260918T145959', opts).until, '2026-09-18');
});

test('Review 3: der Kalender reicht Zone und Start der Serie an Formular und Detailzeile', () => {
  const event = {
    id: 7, title: 'LA', all_day: 0, tzid: 'America/Los_Angeles',
    start_datetime: '2035-10-02T06:30:00Z', end_datetime: '2035-10-02T06:45:00Z',
    recurrence_rule: 'FREQ=DAILY;UNTIL=20351011T065959Z', assigned_users: [],
  };
  let rowValue = null;
  globalThis.__renderRRuleFields = (...args) => realRRule.renderRRuleFields(...args);
  globalThis.__recurrenceRow = (...args) => {
    rowValue = realRRule.parseRRule(args[0], args[1] ?? {}).until;
    return realRRule.recurrenceRow(...args);
  };
  try {
    const html = calendarPage.buildEventModalContent({ mode: 'edit', event });
    assert.match(html, /id="event-rrule-source-until" value="2035-10-10"/, 'das Formular zeigt den 10.10. Ortszeit');
    calendarPage.renderEventDetail(event);
    assert.equal(rowValue, '2035-10-10', 'die Detailzeile endet am 10.10. Ortszeit');
  } finally {
    delete globalThis.__renderRRuleFields;
    delete globalThis.__recurrenceRow;
  }
});

test('Review 4: eine Ortszeit ohne Zone an einer Serie ohne Zone endet bei Google wie in Yuvomi am Tag', () => {
  setHousehold('Europe/Berlin');
  const event = {
    title: 'Floating', all_day: 0, tzid: null,
    start_datetime: '2035-10-01T18:00', end_datetime: '2035-10-01T19:00',
    recurrence_rule: 'FREQ=DAILY;UNTIL=20351010T120000',
  };
  const yuvomi = yuvomiDays(event);
  assert.equal(yuvomi.length, 10, 'Vorbedingung: Yuvomi liest das Ende als Tag');
  const body = google.localEventToGoogle(event, {}, 'Europe/Berlin');
  assert.deepEqual(googleDays(body), yuvomi, body.recurrence[0]);
});
