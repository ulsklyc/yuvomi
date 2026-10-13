/**
 * Test: eine hier verfasste Serie behält ihren ausgerichteten Start beim
 * Anbieter - bei JEDEM Push, nicht nur beim ersten (#1935).
 *
 * Der Anlass: eine Serie "am letzten Tag des Monats", angelegt am 15. Januar,
 * geht mit dem 31. Januar als Start hinaus (#986). Das galt nur für den ersten
 * Upload. Dessen Buchung schreibt `external_source` um, und der ausgehende Weg
 * las genau diese Spalte als Herkunft: ab dann sah die eigene Serie aus wie
 * eine eingelesene, und die nächste Bearbeitung - auch eine, die nur den Titel
 * anfasst - schickte den 15. Januar. Beim Anbieter stand danach eine Serie,
 * deren Start ihre eigene Regel nicht trifft.
 *
 * Geprüft wird die Abnahmetabelle des Tickets, über die echten Wege: echtes
 * `POST /` und `PUT /:id`, echtes `sync()` und `flushOutbound()`; Google ist
 * eine Attrappe, die festhält, was bei ihr liegt, und es zurückliefert, CalDAV
 * und iCloud laufen mit dem echten tsdav-Client gegen test/caldav-fake-server.js.
 *
 *   - zeitgebunden, ganztägig, 23:30 und "letzter Tag, der ein Montag ist":
 *     der erste Upload und der Push nach einer Titeländerung tragen denselben
 *     Start und dasselbe Ende - mit der Bearbeitung VOR und NACH dem ersten Abruf;
 *   - der Abruf schreibt wie vor #1935: er übernimmt den ausgerichteten Start
 *     in die Zeile, die Erinnerungen folgen (#1377), und die Marke fällt, weil
 *     ein anderer Start in die Zeile kommt - der Push danach trägt trotzdem
 *     dasselbe, weil die Zeile den ausgerichteten Start dann selbst hält. Dass
 *     die Eingabe im Abruf stehen bleibt, ist #1956 und hier nicht gebaut;
 *   - Kontrollen: ein Start, der schon passt, und eine BYDAY-Regel (#549);
 *   - eine eingelesene Serie mit einem Start neben ihrer Regel geht nach einer
 *     Titeländerung Wort für Wort zurück (#756);
 *   - wer Start oder Regel einer gespiegelten Serie in Yuvomi ändert, hat sie
 *     ab dann verfasst - auch an einer eingelesenen;
 *   - übernimmt der Abruf vom Anbieter einen anderen Start, fällt die Marke;
 *     schreibt er denselben Start und dieselbe Regel, bleibt sie;
 *   - eine aus einer ICS-Datei importierte Serie zählt als eigene, und der
 *     Abruf wirft an einer markierten Zeile ohne `tzid` nicht.
 *
 * Prozess- und Haushaltszone sind dieselbe und stehen fest; das Skript fährt
 * die Datei einmal in UTC und einmal in Europe/Berlin. Die Tage liegen 2035.
 *
 * Ausführen: npm run test:own-series-origin
 */

// Vor jedem Date: die Zone des Prozesses ist die des Haushalts.
process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const ZONE = process.env.TZ;

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const google        = await import('../server/services/google-calendar.js');
const caldavSync    = await import('../server/services/caldav-sync.js');
const appleCalendar = await import('../server/services/apple-calendar.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { localToUTCPrecise, storedToInstantMsPrecise, utcToWall } = await import('../server/utils/timezone.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

// ── Routen ──────────────────────────────────────────────────────────────────────

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

async function callRoute(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.status < 300, `${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}
const post = (body) => callRoute('POST', '/', body);
const put = (id, body) => callRoute('PUT', `/${id}`, body);
const row = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);

// ── Fixtures ────────────────────────────────────────────────────────────────────

function reset() {
  for (const table of [
    'reminders', 'caldav_upload_attempts', 'calendar_pending_deletions', 'calendar_events',
    'external_calendars', 'caldav_calendar_selection', 'caldav_accounts', 'google_calendar_selection',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'google_%'").run();
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ZONE);
  appleCalendar.clearCredentials();
  dav.reset();
}

/** Wanduhrzeit des Haushalts (oder ein Tag) als vergleichbarer Wert. */
function wall(value) {
  const raw = String(value);
  if (raw.length <= 10) return raw;
  return new Date(localToUTCPrecise(raw.length === 16 ? `${raw}:00` : raw, ZONE)).toISOString();
}

/**
 * Die Erinnerung eines Termins, wie sie der Dialog ablegt: ein Zeitpunkt. Sie
 * hängt am Start der Zeile und zieht mit, wenn der Abruf ihn verlegt (#1377).
 */
function addReminder(eventId, remindAt = '2035-01-15T08:00:00.000Z') {
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, 1)")
    .run(eventId, remindAt);
  return remindAt;
}
const reminderOf = (eventId) => db.prepare(
  "SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?"
).get(eventId)?.remind_at;
/** `remind_at` als Zeitpunkt: die Spalte führt UTC, mit oder ohne `Z`. */
const reminderMs = (eventId) => {
  const raw = String(reminderOf(eventId));
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`);
};
/** Der Beginn einer Zeile als Zeitpunkt (ganztägig: Mitternacht des Haushalts). */
const startMs = (value) => storedToInstantMsPrecise(value, ZONE);

// ── Die drei Anbieter, jeder mit denselben Handgriffen ────────────────────────────

/**
 * Google-Attrappe für ganze Läufe: hält, was `events.insert` und `events.patch`
 * bei ihr ablegen, und liefert es im Abruf zurück, wie die API es dokumentiert -
 * einen Zeitpunkt mit Versatz plus Zone, ganztägig ein reines Datum.
 */
function fakeGoogle() {
  const held = new Map();
  const inserts = [];
  const patches = [];
  const withOffset = (when) => {
    if (!when?.dateTime || /(?:Z|[+-]\d\d:\d\d)$/.test(when.dateTime)) return when;
    const utcMs = Date.parse(localToUTCPrecise(when.dateTime, when.timeZone));
    const minutes = Math.round((Date.parse(`${when.dateTime}Z`) - utcMs) / 60000);
    const sign = minutes < 0 ? '-' : '+';
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const offset = `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
    return { ...when, dateTime: `${when.dateTime}${offset}` };
  };
  return {
    held, inserts, patches,
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
          nextSyncToken: 'token-1935',
        },
      }),
      insert: async (params) => {
        inserts.push(params);
        const id = `created-1935-${inserts.length}`;
        held.set(id, { id, status: 'confirmed', ...params.requestBody });
        return { data: { id } };
      },
      patch: async (params) => {
        patches.push(params);
        held.set(params.eventId, { ...held.get(params.eventId), ...params.requestBody });
        return { data: {} };
      },
      delete: async () => ({}),
    },
  };
}

/** Start und Ende eines Google-Bodys als vergleichbare Werte. */
function googleWhen(body) {
  const one = (when) => {
    if (when.date) return when.date;
    return /(?:Z|[+-]\d\d:\d\d)$/.test(when.dateTime)
      ? new Date(when.dateTime).toISOString()
      : new Date(localToUTCPrecise(when.dateTime, when.timeZone)).toISOString();
  };
  // Ganztägig ist Googles Ende exklusiv: der Tag danach.
  return { start: one(body.start), end: one(body.end) };
}

/** Start und Ende des VEVENT in einem Kalenderobjekt als vergleichbare Werte. */
function icsWhen(data) {
  const one = (prop) => {
    // Erst ab dem VEVENT: ein VTIMEZONE davor trägt eigene DTSTART-Zeilen.
    const vevent = String(data).slice(String(data).indexOf('BEGIN:VEVENT'));
    const line = vevent.split(/\r?\n/).find((l) => l.startsWith(`${prop};`) || l.startsWith(`${prop}:`));
    assert.ok(line, `${prop} fehlt im Objekt:\n${data}`);
    const [head, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    if (/VALUE=DATE(?:;|$)/.test(head)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(value);
    assert.ok(m, `${prop} ist kein Zeitwert: ${line}`);
    const naive = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    if (m[7]) return new Date(`${naive}Z`).toISOString();
    const tzid = /TZID=([^;:]+)/.exec(head)?.[1];
    assert.ok(tzid, `${prop} trägt weder Zone noch Z: ${line}`);
    return new Date(localToUTCPrecise(naive, tzid)).toISOString();
  };
  return { start: one('DTSTART'), end: one('DTEND') };
}

/** Ein fremdes Kalenderobjekt, wie es ein anderer Client auf dem Server ablegt. */
function foreignIcs(uid, { dtstart, dtend, rrule, summary = 'Fremd' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    `DTSTART:${dtstart}`, `DTEND:${dtend}`, `RRULE:${rrule}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * `sent()` ist der letzte Stand, der beim Anbieter angekommen ist, als
 * `{ start, end }`. Für Google der Body des letzten Aufrufs, für CalDAV und
 * iCloud das Objekt, wie es auf dem Server liegt.
 */
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
    push() { return google.flushOutbound({ createCalendar: () => this.calendar }); },
    /** Was der erste Upload trug - und was der letzte Push. */
    first() { return googleWhen(this.calendar.inserts.at(-1).requestBody); },
    last() {
      assert.ok(this.calendar.patches.length > 0, 'die Bearbeitung ist nicht bei Google angekommen');
      return googleWhen(this.calendar.patches.at(-1).requestBody);
    },
    pushes() { return this.calendar.patches.length; },
    /** Legt einen Eintrag ab, als hätte ihn jemand in Google angelegt. */
    seedForeign({ start, end, rrule, zone = ZONE }) {
      this.calendar.held.set('foreign-1935', {
        id: 'foreign-1935', status: 'confirmed', summary: 'Fremd',
        start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone },
        recurrence: [`RRULE:${rrule}`],
      });
      return () => googleWhen(this.calendar.held.get('foreign-1935'));
    },
    /** Ändert beim Anbieter NUR das Ende; Start, Regel und Zone bleiben. */
    changeEndAtProvider(end) {
      const [id, item] = [...this.calendar.held.entries()].at(-1);
      this.calendar.held.set(id, { ...item, end: { dateTime: end, timeZone: item.start.timeZone } });
    },
    /** Ändert beim Anbieter NUR den Titel. */
    renameAtProvider(summary) {
      const [id, item] = [...this.calendar.held.entries()].at(-1);
      this.calendar.held.set(id, { ...item, summary });
    },
    /** Verlegt den Eintrag beim Anbieter, als hätte es jemand in Google getan. */
    moveAtProvider(start, end) {
      const [id, item] = [...this.calendar.held.entries()].at(-1);
      this.calendar.held.set(id, {
        ...item, start: { dateTime: start, timeZone: ZONE }, end: { dateTime: end, timeZone: ZONE },
      });
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
      this.firstSent = null;
      this.puts = () => dav.requests.filter((r) => r.method === 'PUT').length;
    },
    async sync() {
      const before = this.puts();
      await caldavSync.sync();
      // Der erzeugende PUT: was nach dem ersten Lauf mit einem PUT oben liegt.
      if (!this.firstSent && this.puts() > before) this.firstSent = this.onServer();
    },
    push() { return caldavSync.flushOutbound(); },
    onServer() {
      const names = dav.objectNames(this.url).filter((name) => name !== 'foreign.ics');
      assert.equal(names.length, 1, `genau ein eigenes Objekt erwartet, da sind ${names.join(', ') || 'keine'}`);
      return icsWhen(dav.getObject(this.url, names[0]).data);
    },
    first() { return this.firstSent; },
    last() { return this.onServer(); },
    pushes() { return this.puts(); },
    seedForeign({ start, end, rrule }) {
      const stamp = (v) => new Date(wall(v)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      dav.putObject(this.url, 'foreign.ics', foreignIcs('foreign-1935@example.org',
        { dtstart: stamp(start), dtend: stamp(end), rrule }));
      return () => icsWhen(dav.getObject(this.url, 'foreign.ics').data);
    },
    /** Schreibt das VEVENT des eigenen Objekts um; ein VTIMEZONE davor bleibt. */
    rewriteVevent(change) {
      const [name] = dav.objectNames(this.url);
      const stored = dav.getObject(this.url, name).data;
      const at = stored.indexOf('BEGIN:VEVENT');
      dav.putObject(this.url, name, stored.slice(0, at) + change(stored.slice(at)));
    },
    renameAtProvider(summary) {
      this.rewriteVevent((vevent) => vevent.replace(/^SUMMARY:[^\r\n]*/m, `SUMMARY:${summary}`));
    },
    changeEndAtProvider(end) {
      // In der Schreibweise, in der das Objekt liegt: mit TZID die Wanduhr, sonst UTC.
      this.rewriteVevent((vevent) => vevent.replace(/^DTEND([^:\r\n]*):[^\r\n]*/m, (_line, params) => (
        /TZID=/.test(params)
          ? `DTEND${params}:${end.replace(/[-:]/g, '')}00`
          : `DTEND${params}:${new Date(wall(end)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
      )));
    },
    moveAtProvider(start, end) {
      const [name] = dav.objectNames(this.url);
      const stamp = (v) => new Date(wall(v)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      // Nur im VEVENT: ein VTIMEZONE davor trägt eigene DTSTART-Zeilen.
      const stored = dav.getObject(this.url, name).data;
      const at = stored.indexOf('BEGIN:VEVENT');
      const vevent = stored.slice(at)
        .replace(/^DTSTART[^\r\n]*/m, `DTSTART:${stamp(start)}`)
        .replace(/^DTEND[^\r\n]*/m, `DTEND:${stamp(end)}`);
      dav.putObject(this.url, name, stored.slice(0, at) + vevent);
    },
  },
  iCloud: {
    setup() {
      this.url = dav.addCollection('icloud', { name: 'iCloud', components: ['VEVENT'] });
      appleCalendar.saveCredentials(dav.url, 'u', 'p');
      // Die alte iCloud-Verbindung kennt kein Ziel am Termin: hinauf geht, was
      // in keinem oder im Standardkalender liegt.
      this.target = {};
      this.firstSent = null;
      this.puts = () => dav.requests.filter((r) => r.method === 'PUT').length;
    },
    async sync() {
      const before = this.puts();
      await appleCalendar.sync();
      if (!this.firstSent && this.puts() > before) this.firstSent = this.onServer();
    },
    push() { return appleCalendar.flushOutbound(); },
    onServer() { return PROVIDERS.CalDAV.onServer.call(this); },
    first() { return this.firstSent; },
    last() { return this.onServer(); },
    pushes() { return this.puts(); },
    seedForeign(what) { return PROVIDERS.CalDAV.seedForeign.call(this, what); },
    moveAtProvider(start, end) { return PROVIDERS.CalDAV.moveAtProvider.call(this, start, end); },
    rewriteVevent(change) { return PROVIDERS.CalDAV.rewriteVevent.call(this, change); },
    changeEndAtProvider(end) { return PROVIDERS.CalDAV.changeEndAtProvider.call(this, end); },
    renameAtProvider(summary) { return PROVIDERS.CalDAV.renameAtProvider.call(this, summary); },
  },
};

function provider(name) {
  reset();
  const p = Object.create(PROVIDERS[name]);
  p.setup();
  return p;
}

/** Bearbeitet den Titel über die Route und wartet, bis der Push durch ist. */
async function editTitle(p, id, body = { title: 'Neuer Titel' }) {
  const before = p.pushes();
  await put(id, body);
  // Die Route stößt ihren Sofortversuch selbst an; dieser hier reiht sich
  // dahinter ein und endet erst, wenn nichts mehr aussteht.
  await p.push();
  assert.ok(p.pushes() > before, 'die Bearbeitung hat keinen Push ausgelöst');
  assert.equal(row(id).outbound_dirty, 0, 'die Bearbeitung ist nicht hinausgegangen');
}

// ── Die Abnahmetabelle ──────────────────────────────────────────────────────────

const LAST_DAY = 'FREQ=MONTHLY;BYMONTHDAY=-1';

/**
 * `entered` ist, was der Nutzer eingibt; `sent` der Start, den der Anbieter
 * halten muss (Wanduhrzeit des Haushalts bzw. der Tag), `sentEnd` das Ende.
 * Ganztägig nennt `sentEnd` den letzten sichtbaren Tag.
 */
const CASES = [
  {
    name: 'letzter Tag, Start am 15.',
    entered: { start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', recurrence_rule: LAST_DAY },
    sent: '2035-01-31T14:00', sentEnd: '2035-01-31T15:00', aligned: true,
  },
  {
    name: 'letzter Tag, der ein Montag ist, Start am 15.',
    entered: { start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', recurrence_rule: 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1' },
    sent: '2035-04-30T14:00', sentEnd: '2035-04-30T15:00', aligned: true,
  },
  {
    name: 'letzter Tag, ganztägig, Start am 15.',
    entered: { start_datetime: '2035-01-15', end_datetime: '2035-01-15', all_day: 1, recurrence_rule: LAST_DAY },
    sent: '2035-01-31', sentEnd: '2035-01-31', aligned: true,
  },
  {
    name: 'letzter Tag, 23:30, Start am 15.',
    entered: { start_datetime: '2035-01-15T23:30', end_datetime: '2035-01-15T23:45', recurrence_rule: LAST_DAY },
    sent: '2035-01-31T23:30', sentEnd: '2035-01-31T23:45', aligned: true,
  },
  {
    name: 'Kontrolle: letzter Tag, Start am 31.',
    entered: { start_datetime: '2035-01-31T14:00', end_datetime: '2035-01-31T15:00', recurrence_rule: LAST_DAY },
    sent: '2035-01-31T14:00', sentEnd: '2035-01-31T15:00', aligned: false,
  },
  {
    name: 'Kontrolle: wöchentlich dienstags, Start an einem Montag (nie ausgerichtet, #549)',
    entered: { start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' },
    sent: '2035-01-15T14:00', sentEnd: '2035-01-15T15:00', aligned: false,
  },
];

/** Was der Anbieter für diesen Fall halten muss, in der Form von `sent()`. */
function expected(providerName, c) {
  const allDay = !!c.entered.all_day;
  if (!allDay) return { start: wall(c.sent), end: wall(c.sentEnd) };
  // Ganztägig ist das Ende draussen exklusiv (RFC 5545 und Google): der Tag danach.
  const next = new Date(Date.parse(`${c.sentEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { start: c.sent, end: next };
}

for (const name of Object.keys(PROVIDERS)) {
  for (const c of CASES) {
    test(`${name} [${ZONE}] ${c.name}: Bearbeitung VOR dem ersten Abruf`, async () => {
      const p = provider(name);
      const event = await post({ title: 'Miete', ...c.entered, ...p.target });

      await p.sync();
      assert.notEqual(row(event.id).external_source, 'local', 'der Termin ist danach gespiegelt');
      assert.deepEqual(p.first(), expected(name, c), 'der erste Upload');

      await editTitle(p, event.id);
      assert.deepEqual(p.last(), expected(name, c), 'der Push nach der Titeländerung');
      assert.deepEqual(p.last(), p.first(), 'erster Upload und Push nach der Bearbeitung tragen dasselbe');
      assert.equal(row(event.id).series_authored, 1, 'eine hier angelegte Serie trägt die Marke, auch als Spiegel');
    });

    test(`${name} [${ZONE}] ${c.name}: Bearbeitung NACH dem ersten Abruf`, async () => {
      const p = provider(name);
      const event = await post({ title: 'Miete', ...c.entered, ...p.target });
      const remindAt = addReminder(event.id);
      const remindMs = reminderMs(event.id);

      await p.sync();
      assert.deepEqual(p.first(), expected(name, c), 'der erste Upload');

      // Der Abruf liest den eigenen Eintrag zurück - und schreibt wie vor #1935:
      // was beim Anbieter liegt, steht danach in der Zeile.
      const beforeInbound = row(event.id);
      await p.sync();
      const afterInbound = row(event.id);
      const moved = startMs(c.sent) - startMs(c.entered.start_datetime);
      assert.equal(startMs(afterInbound.start_datetime), startMs(c.sent), 'die Zeile trägt den Start des Anbieters');
      assert.equal(reminderMs(event.id) - remindMs, moved, 'die Erinnerung folgt dem Start der Zeile (#1377)');
      if (!c.aligned) assert.equal(reminderOf(event.id), remindAt, 'ohne Verschiebung bleibt die Erinnerung, wie sie war');

      // Die Marke fällt genau dann, wenn ein anderer Start oder eine andere
      // Regel in die Zeile gekommen ist - ohne Urteil darüber, ob es das
      // eigene Echo war.
      const sameText = afterInbound.start_datetime === beforeInbound.start_datetime
        && afterInbound.recurrence_rule === beforeInbound.recurrence_rule;
      assert.equal(beforeInbound.series_authored, 1, 'bis zum Abruf trägt die hier angelegte Serie die Marke');
      assert.equal(afterInbound.series_authored, sameText ? 1 : 0,
        `Start ${beforeInbound.start_datetime} -> ${afterInbound.start_datetime}, `
        + `Regel ${beforeInbound.recurrence_rule} -> ${afterInbound.recurrence_rule}`);
      if (c.aligned) assert.equal(afterInbound.series_authored, 0, 'der ausgerichtete Start ist ein anderer Start: die Marke fällt');

      // Der Push nach der Bearbeitung trägt trotzdem dasselbe: die Zeile hält
      // den ausgerichteten Start jetzt selbst.
      await editTitle(p, event.id);
      assert.deepEqual(p.last(), expected(name, c), 'der Push nach der Titeländerung');
      assert.deepEqual(p.last(), p.first(), 'erster Upload und Push nach der Bearbeitung tragen dasselbe');

      // Und der Abruf danach lässt es dabei.
      await p.sync();
      assert.equal(row(event.id).title, 'Neuer Titel');
      assert.equal(startMs(row(event.id).start_datetime), startMs(c.sent));
      assert.equal(reminderMs(event.id) - remindMs, moved);

      // Das ganze Formular, wie es der Dialog nach dem Abruf schickt: der Start
      // der Zeile als Wanduhrzeit des Haushalts, dieselbe Regel.
      await editTitle(p, event.id, {
        title: 'Noch einmal', start_datetime: c.sent, end_datetime: c.sentEnd,
        all_day: c.entered.all_day ? 1 : 0, recurrence_rule: row(event.id).recurrence_rule,
      });
      assert.deepEqual(p.last(), p.first(), 'auch danach liegt beim Anbieter dasselbe');
    });
  }

  // ── Eingelesen bleibt eingelesen (#756) ────────────────────────────────────────

  test(`${name} [${ZONE}] eine eingelesene Serie geht nach einer Titeländerung Wort für Wort zurück (#756)`, async () => {
    const p = provider(name);
    const atProvider = p.seedForeign({ start: '2035-01-15T14:00', end: '2035-01-15T15:00', rrule: LAST_DAY });
    const before = atProvider();
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
    assert.ok(imported, 'die fremde Serie wurde eingelesen');

    // Nur der Titel.
    await editTitle(p, imported.id, { title: 'Umbenannt' });
    assert.deepEqual(atProvider(), before, 'Start und Ende beim Anbieter sind unverändert');

    // Und das ganze Formular, wie es der Dialog schickt: derselbe Start als
    // Wanduhrzeit des Haushalts, dieselbe Regel.
    await editTitle(p, imported.id, {
      title: 'Noch einmal', start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00',
      all_day: 0, recurrence_rule: row(imported.id).recurrence_rule,
    });
    assert.deepEqual(atProvider(), before, 'derselbe Start in anderer Schreibweise ist keine Startänderung');
    assert.equal(row(imported.id).series_authored, 0, 'eine eingelesene Serie trägt keine Marke, auch nach der Bearbeitung');
  });

  test(`${name} [${ZONE}] Sekunden im eingelesenen Start: das Formular kann sie nicht halten, verfasst ist damit nichts`, async () => {
    // Der Dialog schickt `YYYY-MM-DDTHH:MM` (public/pages/calendar.js,
    // `eventStartFromForm`). Ein eingelesener Start mit Sekunden kommt deshalb
    // bei JEDER Bearbeitung ohne sie zurück. Das ist keine Entscheidung des
    // Nutzers über den Start, und die Serie bleibt die des Anbieters.
    const p = provider(name);
    const atProvider = p.seedForeign({ start: '2035-01-15T14:00:30', end: '2035-01-15T15:00:30', rrule: LAST_DAY });
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
    assert.equal(storedToInstantMsPrecise(imported.start_datetime, ZONE), Date.parse(wall('2035-01-15T14:00:30')),
      'die Sekunden stehen in der Zeile');

    await editTitle(p, imported.id, {
      title: 'Umbenannt', start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00',
      all_day: false, recurrence_rule: LAST_DAY,
    });
    assert.equal(atProvider().start.slice(0, 16), wall('2035-01-15T14:00').slice(0, 16),
      'der Start bleibt am 15., neben der Regel, wie er eingelesen wurde');
    assert.equal(row(imported.id).series_authored, 0);

    // Die Gegenrichtung: eine Minute ist eine Entscheidung über den Start.
    await editTitle(p, imported.id, { start_datetime: '2035-01-15T14:01', end_datetime: '2035-01-15T15:00' });
    assert.equal(row(imported.id).series_authored, 1, 'ein um eine Minute verlegter Start ist verfasst');
    assert.equal(atProvider().start, wall('2035-01-31T14:01'));
  });

  // ── Wer Start oder Regel in Yuvomi ändert, hat sie verfasst ────────────────────

  test(`${name} [${ZONE}] eine eingelesene Serie, deren Regel in Yuvomi geändert wird, ist ab dann verfasst`, async () => {
    const p = provider(name);
    const atProvider = p.seedForeign({ start: '2035-01-15T14:00', end: '2035-01-15T15:00', rrule: 'FREQ=MONTHLY' });
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();

    await editTitle(p, imported.id, { recurrence_rule: LAST_DAY });
    assert.deepEqual(atProvider(), { start: wall('2035-01-31T14:00'), end: wall('2035-01-31T15:00') },
      'dasselbe, was eine frisch angelegte Serie mit diesen Daten trüge');
    assert.equal(imported.series_authored, 0, 'eingelesen trug sie keine Marke');
    assert.equal(row(imported.id).series_authored, 1, 'die Regel stammt jetzt aus Yuvomi');
  });

  test(`${name} [${ZONE}] eine gespiegelte eigene Serie: Regel geändert, Start bleibt`, async () => {
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00',
      recurrence_rule: 'FREQ=MONTHLY', ...p.target,
    });
    await p.sync();
    await p.sync();

    await editTitle(p, event.id, { recurrence_rule: LAST_DAY });
    assert.deepEqual(p.last(), { start: wall('2035-01-31T14:00'), end: wall('2035-01-31T15:00') });
  });

  test(`${name} [${ZONE}] eine gespiegelte eigene Serie: Start verlegt, Regel bleibt`, async () => {
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-31T14:00', end_datetime: '2035-01-31T15:00',
      recurrence_rule: LAST_DAY, ...p.target,
    });
    await p.sync();
    await p.sync();

    await editTitle(p, event.id, { start_datetime: '2035-02-10T14:00', end_datetime: '2035-02-10T15:00' });
    assert.deepEqual(p.last(), { start: wall('2035-02-28T14:00'), end: wall('2035-02-28T15:00') });
    assert.equal(row(event.id).start_datetime, '2035-02-10T14:00', 'in der Zeile steht die Eingabe');
  });

  // ── Derselbe Start, dieselbe Regel: die Marke bleibt ───────────────────────────

  test(`${name} [${ZONE}] schreibt der Abruf denselben Start und dieselbe Regel, bleibt die Marke`, async () => {
    // Ein ganztägiger Einzeltermin: der Anbieter liefert den Tag so zurück, wie
    // er in der Zeile steht, und eine Regel gibt es auf beiden Seiten nicht.
    // (Eine SERIE verliert die Marke beim ersten Abruf immer: hier angelegt
    // steht die Regel ohne `RRULE:` in der Zeile, der Abruf schreibt sie mit -
    // siehe der Test darunter.)
    const p = provider(name);
    const event = await post({
      title: 'Umzug', start_datetime: '2035-01-31', end_datetime: '2035-01-31', all_day: 1, ...p.target,
    });
    await p.sync();
    await p.sync();
    assert.notEqual(row(event.id).external_source, 'local', 'der Termin ist gespiegelt');

    // Ändert der Anbieter nur den Titel, schreibt der Abruf die Zeile - mit
    // demselben Start und derselben (keiner) Regel.
    p.renameAtProvider('Umzug (neu)');
    await p.sync();
    const taken = row(event.id);
    assert.equal(taken.title, 'Umzug (neu)', 'der Abruf hat die Zeile geschrieben');
    assert.equal(taken.start_datetime, '2035-01-31');
    assert.equal(taken.recurrence_rule, null);
    assert.equal(taken.series_authored, 1, 'nichts anderes kam in Start und Regel: die Marke bleibt');
  });

  test(`${name} [${ZONE}] die Schreibweise des Anbieters ist ein anderer Text: die Marke fällt, der Push bleibt richtig`, async () => {
    // Ganztägig und schon am Monatsletzten. Der Abruf schreibt die Regel mit
    // `RRULE:` davor in die Zeile; verglichen wird der Text, also fällt die
    // Marke. Ausgerichtet werden muss an dieser Zeile nichts.
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-31', end_datetime: '2035-01-31', all_day: 1,
      recurrence_rule: LAST_DAY, ...p.target,
    });
    await p.sync();
    await p.sync();
    const taken = row(event.id);
    assert.equal(taken.start_datetime, '2035-01-31');
    assert.equal(taken.recurrence_rule, `RRULE:${LAST_DAY}`, 'die Regel in der Schreibweise des Abrufs');
    assert.equal(taken.series_authored, 0);

    await editTitle(p, event.id);
    assert.deepEqual(p.last(), { start: '2035-01-31', end: '2035-02-01' });
    assert.deepEqual(p.last(), p.first());

    // Wer den Start danach in Yuvomi verlegt, hat ihn wieder verfasst.
    await editTitle(p, event.id, { start_datetime: '2035-02-10', end_datetime: '2035-02-10', all_day: 1 });
    assert.equal(row(event.id).series_authored, 1);
    assert.deepEqual(p.last(), { start: '2035-02-28', end: '2035-03-01' });
  });

  // ── Aus einer ICS-Datei importiert: eine eigene Serie, ohne `tzid` ─────────────

  test(`${name} [${ZONE}] eine markierte Zeile ohne tzid, deren Dauer der Anbieter ändert: der Abruf wirft nicht`, async () => {
    // Der einmalige Import legt den Zeitpunkt der Datei ab, ohne Zone daneben,
    // und die Serie zählt als eigene.
    const p = provider(name);
    await callRoute('POST', '/import', {
      ics: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
        'BEGIN:VEVENT', 'UID:file-1935@example.org', 'DTSTAMP:20260101T090000Z', 'SUMMARY:Aus Datei',
        'DTSTART:20350115T130000Z', 'DTEND:20350115T140000Z', `RRULE:${LAST_DAY}`,
        'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n'),
    });
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Aus Datei'").get();
    assert.ok(imported, 'die Datei wurde importiert');
    assert.equal(imported.series_authored, 1, 'eine aus einer Datei importierte Serie zählt als eigene');
    assert.equal(imported.tzid, null, 'der Import legt keine Zone ab');
    assert.equal(startMs(imported.start_datetime), Date.parse('2035-01-15T13:00:00Z'));
    assert.ok(/Z$/.test(imported.start_datetime), `der Start ist ein Zeitpunkt: ${imported.start_datetime}`);

    if (Object.keys(p.target).length > 0) await put(imported.id, p.target);
    // Die alte iCloud-Verbindung lädt nur hinauf, was keine fremde Kennung
    // trägt, und der Import behält die UID der Datei: dort geht eine solche
    // Zeile gar nicht hinauf. Damit der Abruf sie trotzdem zu sehen bekommt,
    // nimmt die Probe ihr die Kennung - die Form der Zeile (Zeitpunkt, keine
    // Zone, Marke) bleibt die des Imports.
    if (name === 'iCloud') {
      await p.sync();
      assert.equal(p.pushes(), 0, 'mit der UID der Datei lädt die iCloud-Verbindung die Zeile nicht hinauf');
      db.prepare('UPDATE calendar_events SET external_calendar_id = NULL WHERE id = ?').run(imported.id);
    }
    await p.sync();
    assert.deepEqual(p.first(), { start: '2035-01-31T13:00:00.000Z', end: '2035-01-31T14:00:00.000Z' },
      'hinauf geht sie ausgerichtet');

    // Jemand verlängert die Serie beim Anbieter; Start und Regel bleiben.
    p.changeEndAtProvider('2035-01-31T16:30');
    await p.sync();
    const taken = row(imported.id);
    assert.equal(startMs(taken.end_datetime), startMs('2035-01-31T16:30'), 'der Abruf ist durchgelaufen und hat das neue Ende geschrieben');
    assert.equal(startMs(taken.start_datetime), Date.parse('2035-01-31T13:00:00Z'), 'mit dem Start, der beim Anbieter liegt');
    assert.equal(taken.series_authored, 0, 'ein anderer Start kam in die Zeile');

    await editTitle(p, imported.id);
    assert.deepEqual(p.last(), { start: '2035-01-31T13:00:00.000Z', end: wall('2035-01-31T16:30') });
  });

  // ── Der Anbieter verlegt den Start: die Marke fällt ────────────────────────────

  test(`${name} [${ZONE}] übernimmt der Abruf einen anderen Start, gilt der Anbieter und die Marke fällt`, async () => {
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00',
      recurrence_rule: LAST_DAY, ...p.target,
    });
    const remindAt = addReminder(event.id);
    await p.sync();

    // Jemand verlegt die Serie beim Anbieter auf den 20. Januar, 16:00.
    p.moveAtProvider('2035-01-20T16:00', '2035-01-20T17:00');
    await p.sync();
    const taken = row(event.id);
    assert.equal(storedToInstantMsPrecise(taken.start_datetime, ZONE), Date.parse(wall('2035-01-20T16:00')),
      'die Zeile folgt dem Anbieter');
    assert.notEqual(reminderOf(event.id), remindAt, 'eine echte Verschiebung nimmt die Erinnerung mit (#1377)');

    // Ab dann Wort für Wort: der 20. liegt neben der Regel und bleibt stehen.
    await editTitle(p, event.id);
    assert.deepEqual(p.last(), { start: wall('2035-01-20T16:00'), end: wall('2035-01-20T17:00') },
      'ein Start, den der Anbieter gesetzt hat, wird nicht ausgerichtet');
    assert.equal(taken.series_authored, 0, 'Start und Regel sind jetzt die des Anbieters');
  });
}

// ── Die Zone, in der der Anbieter die Serie rechnet ─────────────────────────────
//
// Google bekommt neben dem Zeitpunkt eine `timeZone` und rechnet die Vorkommen
// in IHR - das ist die Zone des Haushalts bzw. des Kalenders, nicht die `tzid`
// der Zeile. Eine eingelesene Serie aus einer anderen Zone, deren Regel in
// Yuvomi geändert wird, muss deshalb in der Zone ausgerichtet werden, die
// hinausgeht: 23:30 in New York ist in Berlin und in UTC schon der Folgetag.

test(`Google [${ZONE}] eine Serie aus einer anderen Zone wird in der Zone ausgerichtet, die hinausgeht`, async () => {
  const p = provider('Google');
  // 15. Januar 23:30 in New York = 16. Januar 04:30 UTC = 05:30 in Berlin.
  p.seedForeign({
    start: '2035-01-15T23:30:00', end: '2035-01-15T23:45:00', rrule: 'FREQ=MONTHLY', zone: 'America/New_York',
  });
  await p.sync();
  const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
  assert.equal(imported.tzid, 'America/New_York');

  await editTitle(p, imported.id, { recurrence_rule: LAST_DAY });
  const { start, end } = p.calendar.patches.at(-1).requestBody;
  assert.equal(start.timeZone, ZONE, 'Google rechnet die Serie in dieser Zone');
  const dayIn = (when) => utcToWall(new Date(when.dateTime).toISOString(), when.timeZone);
  assert.equal(dayIn(start).date, '2035-01-31',
    `der Start liegt in ${ZONE} auf dem Monatsletzten, sonst trifft er die eigene Regel dort nicht`);
  // Dieselbe Uhrzeit wie vorher, in der Zone, die hinausgeht; die Dauer bleibt.
  assert.equal(dayIn(start).time, utcToWall('2035-01-16T04:30:00Z', ZONE).time);
  assert.equal(Date.parse(end.dateTime) - Date.parse(start.dateTime), 15 * 60000);
});

// ── Migration 246: der Bestand ──────────────────────────────────────────────────

test(`[${ZONE}] Migration 246 markiert lokale Zeilen und lässt gespiegelte unbekannt`, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const migration = dbmod.MIGRATIONS.find((m) => m.version === 246);
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY, title TEXT, start_datetime TEXT, recurrence_rule TEXT,
        external_source TEXT NOT NULL DEFAULT 'local', updated_at TEXT
      );
      CREATE TRIGGER trg_calendar_events_updated_at AFTER UPDATE ON calendar_events FOR EACH ROW
        BEGIN UPDATE calendar_events SET updated_at = 'touched' WHERE id = OLD.id; END;
      INSERT INTO calendar_events VALUES
        (1, 'Eigen',    '2035-01-15T14:00', '${LAST_DAY}', 'local',  'original'),
        (2, 'Google',   '2035-01-15T14:00', '${LAST_DAY}', 'google', 'original'),
        (3, 'CalDAV',   '2035-01-31T14:00', '${LAST_DAY}', 'caldav', 'original'),
        (4, 'iCloud',   '2035-01-15T14:00', '${LAST_DAY}', 'apple',  'original'),
        (5, 'Abo',      '2035-01-15T14:00', '${LAST_DAY}', 'ics',    'original');
    `);
    migration.up(database);

    const rows = database.prepare('SELECT id, series_authored, updated_at FROM calendar_events ORDER BY id').all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows.map((r) => r.series_authored), [1, 0, 0, 0, 0],
      'nur die lokale Zeile ist sicher hier verfasst; bei einer gespiegelten wird nicht geraten');
    assert.deepEqual(rows.map((r) => r.updated_at), Array(5).fill('original'),
      'der Nachtrag setzt keinen Termin auf "eben geändert"');

    // Die Trigger sind wieder da, mit ihrem Wortlaut.
    database.exec("UPDATE calendar_events SET title = 'Neu' WHERE id = 2");
    assert.equal(database.prepare('SELECT updated_at FROM calendar_events WHERE id = 2').get().updated_at, 'touched');

    // Neue Zeilen: ohne Angabe unbekannt, und nur 0 oder 1.
    database.exec("INSERT INTO calendar_events (id, title) VALUES (6, 'Später')");
    assert.equal(database.prepare('SELECT series_authored FROM calendar_events WHERE id = 6').get().series_authored, 0);
    assert.throws(() => database.exec('UPDATE calendar_events SET series_authored = 2 WHERE id = 6'), /CHECK/);

    // Ein zweiter Lauf (gedriftete Datenbank, die Spalte steht schon) scheitert nicht.
    migration.up(database);
  } finally { database.close(); }
});

// ── Jede Stelle, die einen Termin anlegt, sagt, wer ihn verfasst hat ─────────────
//
// Der Default der Spalte ist 0 ("unbekannt, wie eingelesen"). Eine neue
// Anlegestelle in Yuvomi, die die Marke vergisst, legte Serien an, die nie
// ausgerichtet hinausgehen - still, weil nichts scheitert. Deshalb muss jedes
// INSERT entweder die Spalte nennen oder die Quelle eines Abrufs fest im Text
// tragen. Die Wege selbst prüfen die Tests darüber; das hier hält nur die Liste.

test('jedes INSERT in calendar_events nennt series_authored oder ist ein Abruf', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../server/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .filter((name) => name.endsWith('.js') && !/^db(-schema-test)?\.js$/.test(name));
  const sites = [];
  for (const name of files) {
    const source = readFileSync(new URL(name, root), 'utf8');
    for (const match of source.matchAll(/INSERT(?: OR \w+)? INTO calendar_events\b[^`]*/g)) {
      sites.push({ name, sql: match[0] });
    }
  }
  assert.ok(sites.length >= 11, `nur ${sites.length} Anlegestellen gefunden - stimmt die Suche noch?`);

  const inbound = sites.filter((s) => /'(google|caldav|apple|ics)'/.test(s.sql));
  const authored = sites.filter((s) => /\bseries_authored\b/.test(s.sql));
  assert.equal(inbound.length, 4, `Abrufe: ${inbound.map((s) => s.name).join(', ')}`);
  assert.deepEqual(inbound.filter((s) => authored.includes(s)).map((s) => s.name), [],
    'ein Abruf legt eine Serie an, die NICHT hier verfasst ist');
  assert.deepEqual(sites.filter((s) => !inbound.includes(s) && !authored.includes(s)).map((s) => s.name), [],
    'diese Stellen legen einen Termin an, ohne zu sagen, wer Start und Regel verfasst hat');
});
