/**
 * Test: ein Serienende aus dem alten Formular (`UNTIL=<datum>T235959Z`) endet
 * bei jedem Empfaenger an demselben Vorkommen wie in Yuvomi (#1992, Rest von
 * #1989/#1974).
 *
 * Bis #1989 schrieb das Formular das Ende einer Serie als `T235959Z`, das Ende
 * des UTC-Tags, und Zeilen von damals tragen es noch. An einer Serie OHNE
 * eigene Zone (`tzid` leer, zonenlose Wanduhr des Haushalts) liest Yuvomis
 * Expansion davon nur das Datum: das letzte Vorkommen ist das an diesem Tag.
 * Google, CalDAV, iCloud und der ICS-Feed lesen den UTC-Zeitpunkt - westlich
 * von UTC (Chicago, 20:00) fehlt dort das letzte Vorkommen, oestlich (Berlin,
 * 00:30) kommt eines dazu.
 *
 * Gemessen wird die Folge, nicht die Schreibweise: aus jedem gebauten Objekt
 * rechnet der Test die Vorkommen des Empfaengers nach (Wanduhr in der
 * gesendeten Zone, jedes Vorkommen bis einschliesslich UNTIL, eigene
 * `Intl`-Uhr) und vergleicht sie mit `expandRecurringEvents`.
 *
 * Dazu die Grenzen: eine eingelesene Regel (`series_authored = 0`) geht Wort
 * fuer Wort hinaus (#756), eine Serie mit eigener Zone oder einem Start mit
 * Zone ebenso (dort lesen Yuvomi und Empfaenger beide den Zeitpunkt). Und der
 * Rueckweg: das Echo der umgeschriebenen Regel laesst Zeile und Marke stehen
 * und loest keinen weiteren Push aus (`outbound_snapshot`, #1956).
 *
 * Feste Daten in 2035. Das Skript faehrt die Datei unter TZ=UTC und
 * TZ=America/Chicago; der Haushalt wechselt innerhalb der Faelle.
 *
 * Ausfuehren: npm run test:legacy-until-outbound
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const ZONE = process.env.TZ;

const db = (await import('../server/db.js')).get();
const google = await import('../server/services/google-calendar.js');
const caldavSync = await import('../server/services/caldav-sync.js');
const apple = await import('../server/services/apple-calendar.js');
const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
const { __test: feed } = await import('../server/services/ics-export.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

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

const addDay = (key) => new Date(Date.parse(`${key}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const dashed = (d8) => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
const wallOf = (d8t) => `${dashed(d8t.slice(0, 8))}T${d8t.slice(9, 11)}:${d8t.slice(11, 13)}:${d8t.slice(13, 15)}`;

/** Ortstage einer TAEGLICHEN Serie: Start (Tag, Uhrzeit, Zone) bis UNTIL-Zeitpunkt. */
function dailyDays(startDay, startTime, zone, untilMs) {
  const days = [];
  for (let day = startDay, i = 0; i < 400; day = addDay(day), i++) {
    if (wallToMs(`${day}T${startTime}`, zone) > untilMs) break;
    days.push(day);
  }
  return days;
}

const untilOf = (rule) => /(?:^|;)UNTIL=([^;]+)/.exec(String(rule).replace(/^RRULE:/, ''))[1];

function googleDays(body) {
  const [startDay, startTime] = body.start.dateTime.split('T');
  return dailyDays(startDay, startTime, body.start.timeZone, utcStampToMs(untilOf(body.recurrence[0])));
}

function icsDays(dtstartLine, rruleValue) {
  const m = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/.exec(dtstartLine);
  assert.ok(m, `unbekanntes DTSTART: ${dtstartLine}`);
  const wall = wallOf(m[2]);
  return dailyDays(wall.slice(0, 10), wall.slice(11), m[1] || 'UTC', utcStampToMs(untilOf(rruleValue)));
}

function lineOf(ics, name) {
  // Nur im VEVENT: ein VTIMEZONE-Block traegt eigene DTSTART-Zeilen.
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const vevent = unfolded.slice(unfolded.indexOf('BEGIN:VEVENT'));
  return vevent.split(/\r?\n/).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

/** Yuvomis Vorkommen derselben Zeile, als Tage. */
function yuvomiDays(event) {
  return expandRecurringEvents([{ id: 1, ...event }], '2035-01-01', '2035-12-31')
    .map((occ) => String(occ.start_datetime).slice(0, 10));
}

function setHousehold(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

/** Was jeder ausgehende Weg aus derselben Zeile macht: Name -> { rule, days }. */
function outbound(event, zone) {
  const out = {};
  const body = google.__test.localEventToGoogle(event, {}, zone);
  out.google = { rule: body.recurrence[0], days: () => googleDays(body) };
  const viaIcs = (ics) => {
    const rule = lineOf(ics, 'RRULE');
    return { rule, days: () => icsDays(lineOf(ics, 'DTSTART'), rule) };
  };
  out.caldavCreate = viaIcs(caldavSync.__test.buildCalDAVICS(event, zone));
  out.icloudCreate = viaIcs(apple.__test.buildICS(event, zone));
  const fields = icsFieldsForEvent(event, zone).fields;
  out.caldavUpdate = {
    rule: fields.RRULE,
    days: () => icsDays(`DTSTART${fields.DTSTART.params}:${fields.DTSTART.value}`, fields.RRULE),
  };
  out.feed = viaIcs(feed.buildVEvent(event, '20350101T000000Z', false, zone).join('\r\n'));
  return out;
}

const LEGACY = 'FREQ=DAILY;UNTIL=20351010T235959Z';

// ── 1. Die Folge: selbst verfasst, ohne Zone ────────────────────────────────

const HOUSEHOLDS = ['UTC', 'America/Chicago', 'Europe/Berlin'];
const TIMES = [['00:30', '00:59'], ['12:00', '12:30'], ['20:00', '20:30'], ['23:30', '23:45']];

for (const household of HOUSEHOLDS) {
  for (const [time, endTime] of TIMES) {
    test(`[${ZONE}] Haushalt ${household}, taeglich ${time}, altes Formularende T235959Z: jeder Empfaenger endet am 10.10. wie Yuvomi`, () => {
      setHousehold(household);
      const event = {
        title: 'Serie', all_day: 0, tzid: null, series_authored: 1,
        start_datetime: `2035-10-01T${time}`, end_datetime: `2035-10-01T${endTime}`,
        recurrence_rule: LEGACY,
      };
      const yuvomi = yuvomiDays(event);
      assert.equal(yuvomi.at(-1), '2035-10-10', 'Vorbedingung: Yuvomi liest das Datum, das letzte Vorkommen ist der 10.10.');
      for (const [weg, sent] of Object.entries(outbound(event, household))) {
        assert.deepEqual(sent.days(), yuvomi, `${weg}: ${sent.rule}`);
      }
    });
  }
}

test(`[${ZONE}] die Faelle aus dem Ticket: Chicago 20:00 und Berlin 00:30, ICS-Feed, Google, CalDAV`, () => {
  setHousehold('America/Chicago');
  const chicago = {
    title: 'C', all_day: 0, tzid: null, series_authored: 1,
    start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30', recurrence_rule: LEGACY,
  };
  // 20:00 CDT am 10.10. ist 01:00Z am 11.: T235959Z liesse es beim Empfaenger weg.
  const c = outbound(chicago, 'America/Chicago');
  assert.equal(c.feed.rule, 'RRULE:FREQ=DAILY;UNTIL=20351011T045959Z');
  assert.equal(c.google.rule, 'RRULE:FREQ=DAILY;UNTIL=20351011T045959Z');
  assert.equal(c.caldavCreate.rule, 'RRULE:FREQ=DAILY;UNTIL=20351011T045959Z');
  assert.equal(c.caldavUpdate.rule, 'FREQ=DAILY;UNTIL=20351011T045959Z');
  assert.equal(c.feed.days().at(-1), '2035-10-10');

  setHousehold('Europe/Berlin');
  const berlin = { ...chicago, start_datetime: '2035-10-01T00:30', end_datetime: '2035-10-01T00:59' };
  // 00:30 CEST am 11.10. ist 22:30Z am 10.: T235959Z zeigte es beim Empfaenger zusaetzlich.
  const b = outbound(berlin, 'Europe/Berlin');
  assert.equal(b.feed.rule, 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  assert.equal(b.google.rule, 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  assert.equal(b.caldavCreate.rule, 'RRULE:FREQ=DAILY;UNTIL=20351010T215959Z');
  assert.equal(b.caldavUpdate.rule, 'FREQ=DAILY;UNTIL=20351010T215959Z');
});

test(`[${ZONE}] das Praefix und die anderen Teile bleiben, nur UNTIL wird zum Ortstag`, () => {
  setHousehold('America/Chicago');
  const event = {
    title: 'P', all_day: 0, tzid: null, series_authored: 1,
    start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30',
    recurrence_rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20351010T235959Z;WKST=MO',
  };
  assert.equal(icsFieldsForEvent(event, 'America/Chicago').fields.RRULE,
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20351011T045959Z;WKST=MO');
});

// ── 2. Gegenproben: was Wort fuer Wort hinausgeht ───────────────────────────

test(`[${ZONE}] Gegenprobe: eine eingelesene Regel (series_authored = 0) geht Wort fuer Wort hinaus (#756)`, () => {
  for (const household of HOUSEHOLDS) {
    setHousehold(household);
    for (const rule of [LEGACY, `RRULE:${LEGACY}`]) {
      const event = {
        title: 'Fremd', all_day: 0, tzid: null, series_authored: 0,
        start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30', recurrence_rule: rule,
      };
      for (const [weg, sent] of Object.entries(outbound(event, household))) {
        assert.equal(untilOf(sent.rule), '20351010T235959Z', `${household} ${weg}: ${sent.rule}`);
      }
    }
  }
});

test(`[${ZONE}] Gegenprobe: eine Zeile ohne Marke (Objekt ohne die Spalte) gilt als eingelesen`, () => {
  setHousehold('America/Chicago');
  const event = {
    title: 'Ohne Spalte', all_day: 0, tzid: null,
    start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30', recurrence_rule: LEGACY,
  };
  for (const [weg, sent] of Object.entries(outbound(event, 'America/Chicago'))) {
    assert.equal(untilOf(sent.rule), '20351010T235959Z', `${weg}: ${sent.rule}`);
  }
});

test(`[${ZONE}] Gegenprobe: eine Serie mit eigener Zone liest Yuvomi selbst als Zeitpunkt - UNTIL bleibt`, () => {
  setHousehold('America/Chicago');
  const event = {
    title: 'Mit Zone', all_day: 0, tzid: 'America/Chicago', series_authored: 1,
    start_datetime: '2035-10-02T01:00:00Z', end_datetime: '2035-10-02T01:30:00Z', recurrence_rule: LEGACY,
  };
  for (const [weg, sent] of Object.entries(outbound(event, 'America/Chicago'))) {
    assert.equal(untilOf(sent.rule), '20351010T235959Z', `${weg}: ${sent.rule}`);
  }
});

test(`[${ZONE}] Gegenprobe: ein Start mit Zone ohne tzid ist ein Zeitpunkt, Yuvomi und Empfaenger lesen beide den Zeitpunkt`, () => {
  setHousehold('America/Chicago');
  const event = {
    title: 'Zeitpunkt', all_day: 0, tzid: null, series_authored: 1,
    start_datetime: '2035-10-01T01:00:00Z', end_datetime: '2035-10-01T01:30:00Z', recurrence_rule: LEGACY,
  };
  const yuvomi = yuvomiDays(event);
  assert.equal(yuvomi.at(-1), '2035-10-10', 'Vorbedingung: 01:00Z am 11.10. liegt hinter UNTIL');
  const fields = icsFieldsForEvent(event, 'America/Chicago').fields;
  assert.equal(untilOf(fields.RRULE), '20351010T235959Z');
});

test(`[${ZONE}] Gegenprobe: eine Ganztagsserie bleibt beim Datum`, () => {
  setHousehold('America/Chicago');
  const event = {
    title: 'Ganztags', all_day: 1, tzid: null, series_authored: 1,
    start_datetime: '2035-10-01', end_datetime: '2035-10-01', recurrence_rule: LEGACY,
  };
  assert.equal(untilOf(icsFieldsForEvent(event, 'America/Chicago').fields.RRULE), '20351010');
  assert.equal(untilOf(google.__test.localEventToGoogle(event, {}, 'America/Chicago').recurrence[0]), '20351010');
});

// ── 3. Der Rueckweg: das Echo der umgeschriebenen Regel ─────────────────────

const app = express();
app.use((req, _res, next) => {
  req.authUserId = 1;
  req.authRole = 'admin';
  req.session = { userId: 1, role: 'admin' };
  next();
});
app.use(express.json());
app.use('/', calendarRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.closeAllConnections?.(); server.close(); });

const dav = await startFakeDavServer();
test.after(() => dav.close());

async function post(body) {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.status < 300, `POST -> ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}
const row = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);

function reset() {
  for (const table of [
    'reminders', 'caldav_upload_attempts', 'calendar_pending_deletions', 'calendar_events',
    'external_calendars', 'caldav_calendar_selection', 'caldav_accounts', 'google_calendar_selection',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'google_%'").run();
  setHousehold(ZONE);
  apple.clearCredentials();
  dav.reset();
}

/** Google-Attrappe: haelt, was sie bekommt, und liefert es mit Versatz plus Zone zurueck. */
function fakeGoogle() {
  const held = new Map();
  const writes = [];
  const withOffset = (when) => {
    if (!when?.dateTime || /(?:Z|[+-]\d\d:\d\d)$/.test(when.dateTime)) return when;
    const minutes = offsetMinutes(wallToMs(when.dateTime, when.timeZone), when.timeZone);
    const sign = minutes < 0 ? '-' : '+';
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    return { ...when, dateTime: `${when.dateTime}${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}` };
  };
  return {
    held, writes,
    calendarList: {
      get: async ({ calendarId }) => ({
        data: { accessRole: 'owner', timeZone: ZONE, summary: calendarId, backgroundColor: '#4285F4' },
      }),
    },
    colors: { get: async () => ({ data: { event: {} } }) },
    events: {
      list: async () => ({
        data: {
          items: [...held.values()].map((item) => ({ ...item, start: withOffset(item.start), end: withOffset(item.end) })),
          nextSyncToken: 'token-1992',
        },
      }),
      insert: async (params) => {
        writes.push(params);
        const id = `created-1992-${writes.length}`;
        held.set(id, { id, status: 'confirmed', ...params.requestBody });
        return { data: { id } };
      },
      patch: async (params) => {
        writes.push(params);
        held.set(params.eventId, { ...held.get(params.eventId), ...params.requestBody });
        return { data: {} };
      },
      delete: async () => ({}),
    },
  };
}

const PROVIDERS = {
  Google: {
    setup() {
      db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_access_token','a')").run();
      db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token','r')").run();
      google.__test.setCalendarEnabled('family', true, { name: 'Family' });
      this.calendar = fakeGoogle();
      this.target = { target_google_calendar_id: 'family' };
    },
    sync() { return google.sync({ createCalendar: () => this.calendar }); },
    pushes() { return this.calendar.writes.length; },
    ruleAtProvider() { return [...this.calendar.held.values()].at(-1).recurrence[0]; },
    changeRuleAtProvider(rule) {
      const [id, item] = [...this.calendar.held.entries()].at(-1);
      this.calendar.held.set(id, { ...item, recurrence: [`RRULE:${rule}`] });
    },
  },
  CalDAV: {
    setup() {
      const accountId = Number(db.prepare(`
        INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
      `).run(dav.url).lastInsertRowid);
      this.url = dav.addCollection('family', { name: 'Familie', components: ['VEVENT'] });
      db.prepare(`
        INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
        VALUES (?, ?, 'Familie', '#4A90E2', 1)
      `).run(accountId, this.url);
      this.target = { target_caldav_account_id: accountId, target_caldav_calendar_url: this.url };
    },
    sync() { return caldavSync.sync(); },
    pushes() { return dav.requests.filter((r) => r.method === 'PUT').length; },
    ruleAtProvider() {
      const [name] = dav.objectNames(this.url);
      return lineOf(dav.getObject(this.url, name).data, 'RRULE');
    },
    changeRuleAtProvider(rule) {
      const [name] = dav.objectNames(this.url);
      const data = dav.getObject(this.url, name).data;
      // Nur im VEVENT: ein VTIMEZONE davor traegt eigene RRULE-Zeilen.
      const at = data.indexOf('BEGIN:VEVENT');
      dav.putObject(this.url, name, data.slice(0, at) + data.slice(at).replace(/^RRULE:[^\r\n]*/m, `RRULE:${rule}`));
    },
  },
  iCloud: {
    setup() {
      this.url = dav.addCollection('icloud', { name: 'iCloud', components: ['VEVENT'] });
      apple.saveCredentials(dav.url, 'u', 'p');
      this.target = {};
    },
    sync() { return apple.sync(); },
    pushes() { return dav.requests.filter((r) => r.method === 'PUT').length; },
    ruleAtProvider() { return PROVIDERS.CalDAV.ruleAtProvider.call(this); },
    changeRuleAtProvider(rule) { return PROVIDERS.CalDAV.changeRuleAtProvider.call(this, rule); },
  },
};

/** Das Ende des Ortstags 10.10. in der Prozess- (= Haushalts-)zone, als UTC-Zeitpunkt. */
const LOCAL_DAY_END = { UTC: '20351010T235959Z', 'America/Chicago': '20351011T045959Z' }[ZONE];
assert.ok(LOCAL_DAY_END, `kein erwartetes Tagesende fuer ${ZONE}`);

/** Legt die Serie in der alten Form ueber die Route an und laedt sie hinauf. */
async function pushedLegacy(name) {
  reset();
  const p = Object.create(PROVIDERS[name]);
  p.setup();
  const event = await post({
    title: 'Abendkurs', start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30',
    recurrence_rule: LEGACY, ...p.target,
  });
  await p.sync();
  assert.notEqual(row(event.id).external_source, 'local', 'der Termin ist gespiegelt');
  return { p, id: event.id };
}

for (const name of Object.keys(PROVIDERS)) {
  test(`${name} [${ZONE}] Kontrolle: ein anderes UNTIL beim Anbieter ist ein Wechsel - Regel kommt, Marke faellt`, async () => {
    const { p, id } = await pushedLegacy(name);
    p.changeRuleAtProvider('FREQ=DAILY;UNTIL=20351005T120000Z');
    await p.sync();
    const r = row(id);
    assert.match(r.recurrence_rule, /UNTIL=20351005T120000Z/);
    assert.equal(r.series_authored, 0);
  });

  test(`${name} [${ZONE}] Echo der umgeschriebenen Regel: Zeile und Marke bleiben, kein weiterer Push`, async () => {
    reset();
    const p = Object.create(PROVIDERS[name]);
    p.setup();
    const event = await post({
      title: 'Abendkurs', start_datetime: '2035-10-01T20:00', end_datetime: '2035-10-01T20:30',
      recurrence_rule: LEGACY, ...p.target,
    });
    const entered = row(event.id);
    assert.equal(entered.recurrence_rule, LEGACY, 'Vorbedingung: die Zeile traegt die alte Form');
    assert.equal(entered.series_authored, 1);
    assert.equal(entered.tzid, null);

    await p.sync();
    assert.notEqual(row(event.id).external_source, 'local', 'der Termin ist gespiegelt');
    assert.equal(untilOf(p.ruleAtProvider()), LOCAL_DAY_END, 'hinaus ging das Ende des Ortstags');
    const pushesAfterUpload = p.pushes();

    for (const round of ['erster', 'zweiter', 'dritter']) {
      await p.sync();
      const r = row(event.id);
      assert.equal(r.recurrence_rule, LEGACY, `${round} Abruf: die Regel bleibt, wie sie gespeichert war`);
      assert.equal(r.start_datetime, '2035-10-01T20:00', `${round} Abruf: der Start bleibt`);
      assert.equal(r.tzid, null, `${round} Abruf: keine Zone kommt hinzu`);
      assert.equal(r.series_authored, 1, `${round} Abruf: die Marke bleibt`);
      assert.equal(r.outbound_dirty, 0, `${round} Abruf: nichts wartet auf einen Push`);
      assert.equal(p.pushes(), pushesAfterUpload, `${round} Abruf: kein weiterer Push`);
    }
    assert.equal(untilOf(p.ruleAtProvider()), LOCAL_DAY_END, 'beim Anbieter liegt weiter dasselbe');
  });
}
