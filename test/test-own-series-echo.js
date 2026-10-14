/**
 * Test: der Abruf erkennt das Echo des eigenen ausgerichteten Pushs (#1956).
 *
 * Eine hier verfasste Serie "am letzten Tag des Monats", eingegeben am 15.
 * Januar, geht mit dem 31. Januar als Start hinaus (#986, #1935). Der Abruf
 * danach las genau diesen Start zurück und schrieb ihn in die Zeile: aus der
 * Eingabe wurde der 31., die Marke `series_authored` fiel und die Erinnerung
 * zog um 16 Tage mit (#1377) - obwohl beim Anbieter niemand etwas getan hatte.
 *
 * Der Push haelt jetzt fest, was er gesendet hat (`outbound_snapshot`), samt
 * dem Zeilenstand, aus dem er entstand. Ein Abruf ist das Echo dieses Pushs,
 * wenn (a) Start, Ende, ganztaegig, Regel und Zone der Zeile seit dem Push
 * unveraendert sind und (b) der Anbieter genau das Gesendete zurueckliefert, in
 * der Lesart des Abrufs gelesen. Dann bleiben die fuenf Felder wie eingegeben,
 * die Marke bleibt, die Erinnerungen bleiben; alles andere nimmt den Weg von
 * vorher.
 *
 * Gefahren wird ueber die echten Wege (POST/PUT der Route, `sync()` und
 * `flushOutbound()` aller drei Anbieter; Google als Attrappe, die haelt, was
 * sie bekommt, CalDAV und iCloud mit dem echten tsdav gegen
 * test/caldav-fake-server.js). Die Datei laeuft in UTC und in Europe/Berlin,
 * Prozess- und Haushaltszone jeweils gleich; ein Fall verschiebt die
 * Haushaltszone zwischen Push und Abruf.
 *
 * Ausfuehren: npm run test:own-series-echo
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const ZONE = process.env.TZ;
// Ein anderer Name fuer dieselbe Uhr: was ein Server aus einer TZID machen kann.
const ALIAS = { UTC: 'Etc/UTC', 'Europe/Berlin': 'Europe/Oslo' }[ZONE];
assert.ok(ALIAS, `keine Alias-Zone fuer ${ZONE}`);

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const google        = await import('../server/services/google-calendar.js');
const caldavSync    = await import('../server/services/caldav-sync.js');
const appleCalendar = await import('../server/services/apple-calendar.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { localToUTCPrecise, utcToWall } = await import('../server/utils/timezone.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

// ── Routen ──────────────────────────────────────────────────────────────────

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

// ── Fixtures ────────────────────────────────────────────────────────────────

function setHousehold(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

function reset() {
  for (const table of [
    'reminders', 'caldav_upload_attempts', 'calendar_pending_deletions', 'calendar_events',
    'external_calendars', 'caldav_calendar_selection', 'caldav_accounts', 'google_calendar_selection',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'google_%'").run();
  setHousehold(ZONE);
  appleCalendar.clearCredentials();
  dav.reset();
}

/** Wanduhrzeit des Haushalts (oder ein Tag) als vergleichbarer Wert. */
function wall(value, zone = ZONE) {
  const raw = String(value);
  if (raw.length <= 10) return raw;
  return new Date(localToUTCPrecise(raw.length === 16 ? `${raw}:00` : raw, zone)).toISOString();
}
/** Ein gespeicherter Start als Zeitpunkt; eine zonenlose Wanduhr in der Zone des Haushalts. */
const startMs = (value) => {
  const raw = String(value);
  if (raw.length <= 10) return Date.parse(wall(`${raw}T00:00`));
  return /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? Date.parse(raw) : Date.parse(wall(raw));
};

function addReminder(eventId, remindAt = '2035-01-15T08:00:00.000Z') {
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, 1)")
    .run(eventId, remindAt);
  return remindAt;
}
const reminderOf = (eventId) => db.prepare(
  "SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?"
).get(eventId)?.remind_at;

/** Start und Ende eines Google-Bodys als vergleichbare Werte. */
function googleWhen(body) {
  const one = (when) => {
    if (when.date) return when.date;
    return /(?:Z|[+-]\d\d:\d\d)$/.test(when.dateTime)
      ? new Date(when.dateTime).toISOString()
      : new Date(localToUTCPrecise(when.dateTime, when.timeZone)).toISOString();
  };
  return { start: one(body.start), end: one(body.end) };
}

/** Start und Ende des VEVENT in einem Kalenderobjekt als vergleichbare Werte. */
function icsWhen(data) {
  const one = (prop) => {
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
    assert.ok(tzid, `${prop} traegt weder Zone noch Z: ${line}`);
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

const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dayAfter = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
/** Ein Zeitpunkt als Wanduhr-Ziffern einer Zone, fuer eine TZID-Zeile. */
const wallDigits = (iso, zone) => {
  const w = utcToWall(iso, zone);
  return `${w.date.replace(/-/g, '')}T${w.time.replace(/:/g, '')}`;
};

/** Eine DTSTART/DTEND-Zeile neu setzen, mit TZID als Wanduhr dieser Zone, sonst in UTC. */
function setDt(vevent, prop, value) {
  return vevent.replace(new RegExp(`^${prop}([^:\\r\\n]*):[^\\r\\n]*`, 'm'), (_line, params) => {
    const tzid = /TZID=([^;:]+)/.exec(params)?.[1];
    return tzid ? `${prop}${params}:${wallDigits(wall(value), tzid)}` : `${prop}${params}:${stamp(wall(value))}`;
  });
}

// ── Google-Attrappe ─────────────────────────────────────────────────────────

/**
 * Haelt, was `events.insert` und `events.patch` bei ihr ablegen, und liefert es
 * im Abruf zurueck, wie die API es dokumentiert - einen Zeitpunkt mit Versatz
 * plus Zone, ganztaegig ein reines Datum.
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
          nextSyncToken: 'token-1956',
        },
      }),
      insert: async (params) => {
        inserts.push(params);
        const id = `created-1956-${inserts.length}`;
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

// ── Die drei Anbieter, jeder mit denselben Handgriffen ──────────────────────

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
    first() { return googleWhen(this.calendar.inserts.at(-1).requestBody); },
    last() {
      const last = this.calendar.patches.at(-1) ?? this.calendar.inserts.at(-1);
      return googleWhen(last.requestBody);
    },
    pushes() { return this.calendar.inserts.length + this.calendar.patches.length; },
    own() {
      const entry = [...this.calendar.held.entries()].find(([id]) => !id.startsWith('foreign'))
        ?? [...this.calendar.held.entries()].at(-1);
      assert.ok(entry, 'bei Google liegt nichts');
      return entry;
    },
    edit(change) {
      const [id, item] = this.own();
      this.calendar.held.set(id, { ...item, ...change(item) });
    },
    seedForeign({ start, end, rrule, zone = ZONE }) {
      this.calendar.held.set('foreign-1956', {
        id: 'foreign-1956', status: 'confirmed', summary: 'Fremd',
        start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone },
        recurrence: [`RRULE:${rrule}`],
      });
      return () => googleWhen(this.calendar.held.get('foreign-1956'));
    },
    renameAtProvider(summary) { this.edit(() => ({ summary })); },
    moveAtProvider(start, end) {
      this.edit(() => ({ start: { dateTime: start, timeZone: ZONE }, end: { dateTime: end, timeZone: ZONE } }));
    },
    changeEndAtProvider(end) { this.edit((item) => ({ end: { dateTime: end, timeZone: item.start.timeZone } })); },
    changeRuleAtProvider(rule) { this.edit(() => ({ recurrence: [`RRULE:${rule}`] })); },
    ruleAtProvider() { return this.own()[1].recurrence[0].replace(/^RRULE:/, ''); },
    /** Dieselben Zeitpunkte in einer anderen Zone. */
    changeZoneAtProvider(zone) {
      this.edit((item) => {
        const when = googleWhen(item);
        return { start: { dateTime: when.start, timeZone: zone }, end: { dateTime: when.end, timeZone: zone } };
      });
    },
    flipAllDayAtProvider() {
      this.edit((item) => {
        if (item.start.date) {
          return { start: { dateTime: `${item.start.date}T09:00:00`, timeZone: ZONE }, end: { dateTime: `${item.start.date}T10:00:00`, timeZone: ZONE } };
        }
        const day = utcToWall(googleWhen(item).start, ZONE).date;
        return { start: { date: day }, end: { date: dayAfter(day) } };
      });
    },
    failPushes() {
      this.calendar.events.patch = async () => { throw Object.assign(new Error('Backend Error'), { code: 503 }); };
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
      if (!this.firstSent && this.puts() > before) this.firstSent = this.onServer();
    },
    push() { return caldavSync.flushOutbound(); },
    ownName() {
      const names = dav.objectNames(this.url).filter((name) => name !== 'foreign.ics');
      assert.equal(names.length, 1, `genau ein eigenes Objekt erwartet, da sind ${names.join(', ') || 'keine'}`);
      return names[0];
    },
    onServer() { return icsWhen(dav.getObject(this.url, this.ownName()).data); },
    first() { return this.firstSent; },
    last() { return this.onServer(); },
    pushes() { return this.puts(); },
    seedForeign({ start, end, rrule }) {
      dav.putObject(this.url, 'foreign.ics', foreignIcs('foreign-1956@example.org',
        { dtstart: stamp(wall(start)), dtend: stamp(wall(end)), rrule }));
      return () => icsWhen(dav.getObject(this.url, 'foreign.ics').data);
    },
    /** Schreibt das VEVENT des eigenen Objekts um; ein VTIMEZONE davor bleibt. */
    rewriteVevent(change) {
      const name = this.ownName();
      const stored = dav.getObject(this.url, name).data;
      const at = stored.indexOf('BEGIN:VEVENT');
      dav.putObject(this.url, name, stored.slice(0, at) + change(stored.slice(at)));
    },
    renameAtProvider(summary) {
      this.rewriteVevent((vevent) => vevent.replace(/^SUMMARY:[^\r\n]*/m, `SUMMARY:${summary}`));
    },
    /** Verlegt beim Anbieter, in der Schreibweise, in der das Objekt liegt (TZID bleibt). */
    moveAtProvider(start, end) {
      this.rewriteVevent((vevent) => setDt(setDt(vevent, 'DTSTART', start), 'DTEND', end));
    },
    changeEndAtProvider(end) {
      this.rewriteVevent((vevent) => setDt(vevent, 'DTEND', end));
    },
    changeRuleAtProvider(rule) {
      this.rewriteVevent((vevent) => vevent.replace(/^RRULE:[^\r\n]*/m, `RRULE:${rule}`));
    },
    ruleAtProvider() {
      const data = dav.getObject(this.url, this.ownName()).data;
      return /^RRULE:([^\r\n]*)/m.exec(data.slice(data.indexOf('BEGIN:VEVENT')))[1];
    },
    /** Dieselben Zeitpunkte, als Wanduhr einer anderen Zone geschrieben. */
    changeZoneAtProvider(zone) {
      const when = this.onServer();
      this.rewriteVevent((vevent) => vevent
        .replace(/^DTSTART[^\r\n]*/m, `DTSTART;TZID=${zone}:${wallDigits(when.start, zone)}`)
        .replace(/^DTEND[^\r\n]*/m, `DTEND;TZID=${zone}:${wallDigits(when.end, zone)}`));
    },
    flipAllDayAtProvider() {
      const when = this.onServer();
      if (when.start.length === 10) {
        this.rewriteVevent((vevent) => vevent
          .replace(/^DTSTART[^\r\n]*/m, `DTSTART:${stamp(wall(`${when.start}T09:00`))}`)
          .replace(/^DTEND[^\r\n]*/m, `DTEND:${stamp(wall(`${when.start}T10:00`))}`));
        return;
      }
      const day = utcToWall(when.start, ZONE).date;
      this.rewriteVevent((vevent) => vevent
        .replace(/^DTSTART[^\r\n]*/m, `DTSTART;VALUE=DATE:${day.replace(/-/g, '')}`)
        .replace(/^DTEND[^\r\n]*/m, `DTEND;VALUE=DATE:${dayAfter(day).replace(/-/g, '')}`));
    },
    failPushes() { dav.refuse({ method: 'PUT', status: 503 }); },
  },
  iCloud: {
    setup() {
      this.url = dav.addCollection('icloud', { name: 'iCloud', components: ['VEVENT'] });
      appleCalendar.saveCredentials(dav.url, 'u', 'p');
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
  },
};
// iCloud teilt Server und Objektform mit CalDAV: dieselben Handgriffe.
for (const key of ['ownName', 'onServer', 'first', 'last', 'pushes', 'seedForeign', 'rewriteVevent',
  'renameAtProvider', 'moveAtProvider', 'changeEndAtProvider', 'changeRuleAtProvider', 'ruleAtProvider',
  'changeZoneAtProvider', 'flipAllDayAtProvider', 'failPushes']) {
  if (!PROVIDERS.iCloud[key]) PROVIDERS.iCloud[key] = PROVIDERS.CalDAV[key];
}

function provider(name) {
  reset();
  const p = Object.create(PROVIDERS[name]);
  p.setup();
  return p;
}

/** Bearbeitet ueber die Route und wartet, bis der Push durch ist. */
async function editTitle(p, id, body = { title: 'Neuer Titel' }) {
  const before = p.pushes();
  await put(id, body);
  await p.push();
  assert.ok(p.pushes() > before, 'die Bearbeitung hat keinen Push ausgeloest');
  assert.equal(row(id).outbound_dirty, 0, 'die Bearbeitung ist nicht hinausgegangen');
}

// ── Die Faelle ──────────────────────────────────────────────────────────────

const LAST_DAY = 'FREQ=MONTHLY;BYMONTHDAY=-1';

const CASES = [
  {
    name: 'zeitgebunden',
    entered: { start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', recurrence_rule: LAST_DAY },
    sent: '2035-01-31T14:00', sentEnd: '2035-01-31T15:00',
  },
  {
    name: 'ganztaegig',
    entered: { start_datetime: '2035-01-15', end_datetime: '2035-01-15', all_day: 1, recurrence_rule: LAST_DAY },
    sent: '2035-01-31', sentEnd: '2035-01-31',
  },
  {
    name: '23:30',
    entered: { start_datetime: '2035-01-15T23:30', end_datetime: '2035-01-15T23:45', recurrence_rule: LAST_DAY },
    sent: '2035-01-31T23:30', sentEnd: '2035-01-31T23:45',
  },
  {
    name: 'letzter Tag, der ein Montag ist',
    entered: { start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', recurrence_rule: 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1' },
    sent: '2035-04-30T14:00', sentEnd: '2035-04-30T15:00',
  },
];
const TIMED = CASES[0];

/**
 * Legt die Serie ueber die Route an und laedt sie hinauf. Vorbedingung: das
 * Ausrichten hat den Start verschoben, sonst prueft der Fall nichts.
 */
async function pushedSeries(p, c = TIMED) {
  const event = await post({ title: 'Miete', ...c.entered, ...p.target });
  const remindAt = addReminder(event.id);
  await p.sync();
  assert.notEqual(row(event.id).external_source, 'local', 'der Termin ist gespiegelt');
  assert.equal(p.first().start, wall(c.sent), 'Vorbedingung: der Upload traegt den ausgerichteten Start');
  return { id: event.id, remindAt, c };
}

/** Die fuenf Felder stehen wie eingegeben, Marke und Erinnerung auch. */
function assertKept({ id, remindAt, c }, msg = '') {
  const r = row(id);
  assert.deepEqual(
    { start: r.start_datetime, end: r.end_datetime, allDay: r.all_day, rule: r.recurrence_rule, tzid: r.tzid },
    {
      start: c.entered.start_datetime, end: c.entered.end_datetime, allDay: c.entered.all_day ? 1 : 0,
      rule: c.entered.recurrence_rule, tzid: null,
    },
    `die Zeile steht wie eingegeben ${msg}`,
  );
  assert.equal(r.series_authored, 1, `die Marke bleibt ${msg}`);
  assert.equal(reminderOf(id), remindAt, `die Erinnerung bleibt ${msg}`);
}

/** Der heutige Weg: was beim Anbieter liegt, steht in der Zeile, die Marke faellt. */
function assertTaken({ id }, msg = '') {
  const r = row(id);
  assert.equal(r.series_authored, 0, `die Marke faellt ${msg}`);
  return r;
}

for (const name of Object.keys(PROVIDERS)) {
  // ── 1. Das Echo selbst ────────────────────────────────────────────────────
  for (const c of CASES) {
    test(`${name} [${ZONE}] Echo einer ausgerichteten Serie (${c.name}): die Zeile bleibt, wie sie eingegeben wurde`, async () => {
      const p = provider(name);
      const s = await pushedSeries(p, c);
      await p.sync();
      assertKept(s, 'nach dem ersten Abruf');
      await p.sync();
      assertKept(s, 'nach dem zweiten Abruf');
      assert.deepEqual(p.last(), p.first(), 'beim Anbieter liegt weiter dasselbe');
    });
  }

  // ── Ein Feld anders, alles andere ist das Echo ────────────────────────────
  test(`${name} [${ZONE}] nur der Titel beim Anbieter: der Zeitplan ist Echo, der Titel kommt`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.renameAtProvider('Miete (neu)');
    await p.sync();
    assertKept(s);
    assert.equal(row(s.id).title, 'Miete (neu)');
  });

  test(`${name} [${ZONE}] nur der Start beim Anbieter eine Minute spaeter (Ende bleibt): ein Wechsel, die Erinnerung folgt`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.moveAtProvider('2035-01-31T14:01', '2035-01-31T15:00');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:01'));
    assert.notEqual(reminderOf(s.id), s.remindAt, 'die Erinnerung folgt dem Start (#1377)');
  });

  test(`${name} [${ZONE}] Start beim Anbieter verlegt: ein Wechsel`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.moveAtProvider('2035-01-20T16:00', '2035-01-20T17:00');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-20T16:00'));
  });

  test(`${name} [${ZONE}] Start beim Anbieter zurueck auf den eingegebenen Tag: ein Wechsel`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.moveAtProvider('2035-01-15T14:00', '2035-01-15T15:00');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-15T14:00'));
  });

  test(`${name} [${ZONE}] Regel beim Anbieter geaendert: ein Wechsel`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.changeRuleAtProvider('FREQ=MONTHLY;BYMONTHDAY=-2');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(r.recurrence_rule.replace(/^RRULE:/, ''), 'FREQ=MONTHLY;BYMONTHDAY=-2');
  });

  test(`${name} [${ZONE}] ganztaegig beim Anbieter umgeschaltet: ein Wechsel`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.flipAllDayAtProvider();
    await p.sync();
    const r = assertTaken(s);
    assert.equal(r.all_day, 1);
  });

  test(`${name} [${ZONE}] BYDAY beim Anbieter umsortiert: dieselbe Regel, ein Echo`, async () => {
    const p = provider(name);
    const c = {
      name: 'Montag oder Dienstag',
      entered: { ...TIMED.entered, recurrence_rule: 'FREQ=MONTHLY;BYDAY=MO,TU;BYMONTHDAY=-1' },
      sent: '2035-04-30T14:00', sentEnd: '2035-04-30T15:00',
    };
    const s = await pushedSeries(p, c);
    p.changeRuleAtProvider('BYMONTHDAY=-1;BYDAY=TU,MO;FREQ=MONTHLY');
    await p.sync();
    assertKept(s);
  });

  // ── 6. UNTIL ──────────────────────────────────────────────────────────────
  test(`${name} [${ZONE}] UNTIL: die eigene Schreibweise kommt zurueck - ein Echo, die Zeile behaelt ihre`, async () => {
    const p = provider(name);
    const c = { ...TIMED, entered: { ...TIMED.entered, recurrence_rule: `${LAST_DAY};UNTIL=20351231` } };
    const s = await pushedSeries(p, c);
    if (name === 'Google') {
      // Das Ende des Ortstags in der gesendeten Zone (#1974): diese Form steht
      // im Schnappschuss, sonst waere das Echo einer Serie mit Datums-UNTIL nie gleich.
      const localDayEnd = { UTC: '20351231T235959Z', 'Europe/Berlin': '20351231T225959Z' }[ZONE];
      assert.equal(p.ruleAtProvider(), `${LAST_DAY};UNTIL=${localDayEnd}`,
        'Vorbedingung: Google bekam das UNTIL als Ende des Ortstags');
    }
    await p.sync();
    assertKept(s);
  });

  test(`${name} [${ZONE}] UNTIL: eine dritte Schreibweise ist ein Wechsel`, async () => {
    const p = provider(name);
    const c = { ...TIMED, entered: { ...TIMED.entered, recurrence_rule: `${LAST_DAY};UNTIL=20351231` } };
    const s = await pushedSeries(p, c);
    p.changeRuleAtProvider(`${LAST_DAY};UNTIL=20351231T120000Z`);
    await p.sync();
    const r = assertTaken(s);
    assert.match(r.recurrence_rule, /UNTIL=20351231T120000Z/);
  });

  // ── 3. Zeitpunkt ohne Zone (Datei-Import) ─────────────────────────────────
  test(`${name} [${ZONE}] ein Zeitpunkt ohne Zone (Datei-Import): das Echo laesst die Zeile, der Lauf wirft nicht`, async () => {
    const p = provider(name);
    await callRoute('POST', '/import', {
      ics: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
        'BEGIN:VEVENT', 'UID:file-1956@example.org', 'DTSTAMP:20260101T090000Z', 'SUMMARY:Aus Datei',
        'DTSTART:20350115T130000Z', 'DTEND:20350115T140000Z', `RRULE:${LAST_DAY}`,
        'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n'),
    });
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Aus Datei'").get();
    assert.equal(imported.series_authored, 1);
    assert.equal(imported.tzid, null);
    if (Object.keys(p.target).length > 0) await put(imported.id, p.target);
    if (name === 'iCloud') {
      // Wie in test:own-series-origin: die alte iCloud-Verbindung laedt nur
      // hinauf, was keine fremde Kennung traegt.
      db.prepare('UPDATE calendar_events SET external_calendar_id = NULL WHERE id = ?').run(imported.id);
    }
    const before = row(imported.id);
    await p.sync();
    assert.equal(p.first().start, '2035-01-31T13:00:00.000Z', 'Vorbedingung: hinauf geht sie ausgerichtet');
    await p.sync();
    const after = row(imported.id);
    assert.equal(after.start_datetime, before.start_datetime);
    assert.equal(after.end_datetime, before.end_datetime);
    assert.equal(after.tzid, null);
    assert.equal(after.recurrence_rule, before.recurrence_rule);
    assert.equal(after.series_authored, 1);
  });

  // ── 4. Nur die Dauer: Stufe 1 ist der heutige Weg ─────────────────────────
  test(`${name} [${ZONE}] nur die Dauer beim Anbieter: der heutige Weg (Stufe 1)`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.changeEndAtProvider('2035-01-31T16:30');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:00'), 'der Start des Anbieters kommt mit');
    assert.equal(startMs(r.end_datetime), startMs('2035-01-31T16:30'));
    assert.notEqual(reminderOf(s.id), s.remindAt, 'die Erinnerung folgt dem Start (#1377)');
  });

  // ── 5. Nur die Zone ───────────────────────────────────────────────────────
  test(`${name} [${ZONE}] nur die Zone beim Anbieter, dieselben Zeitpunkte und dieselbe Regel: ein Wechsel`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.changeZoneAtProvider('America/New_York');
    await p.sync();
    const r = assertTaken(s);
    assert.equal(r.tzid, 'America/New_York');
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:00'));
    assert.notEqual(reminderOf(s.id), s.remindAt, 'die Erinnerung folgt dem Start (#1377)');
  });

  // ── Lebenslauf ────────────────────────────────────────────────────────────
  test(`${name} [${ZONE}] eine lokale Aenderung, deren Push aufgegeben wurde: der Schnappschuss gilt nicht mehr`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    // Der Endzustand eines aufgegebenen Pushs: die Zeile ist geaendert, nichts
    // wartet mehr, beim Anbieter liegt der alte Stand.
    db.prepare("UPDATE calendar_events SET start_datetime = '2035-02-10T14:00', end_datetime = '2035-02-10T15:00', outbound_dirty = 0 WHERE id = ?").run(s.id);
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:00'), 'der Anbieter gilt, wie bisher');
  });

  test(`${name} [${ZONE}] ein wartender Push: der Abruf laesst die Zeile stehen (#593)`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.failPushes();
    await put(s.id, { title: 'Lokal geaendert' });
    await p.push();
    await p.sync();
    const r = row(s.id);
    assert.equal(r.outbound_dirty, 1, 'die Aenderung wartet weiter');
    assert.equal(r.title, 'Lokal geaendert');
    assertKept(s);
    dav.allowAll();
  });

  test(`${name} [${ZONE}] die Haushaltszone wechselt nach dem Push: weiter ein Echo`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    setHousehold('America/Los_Angeles');
    await p.sync();
    assertKept(s);
  });

  test(`${name} [${ZONE}] eine Titelaenderung nach dem Echo schickt den ausgerichteten Start wieder`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    await p.sync();
    assertKept(s, 'nach dem Echo');
    await editTitle(p, s.id);
    assert.deepEqual(p.last(), p.first(), 'derselbe ausgerichtete Start wie beim ersten Upload');
    await p.sync();
    assertKept(s, 'nach dem Echo des zweiten Pushs');
    assert.equal(row(s.id).title, 'Neuer Titel');
  });

  test(`${name} [${ZONE}] Kontrolle: ein Start, den das Ausrichten nicht verschiebt, bekommt keinen Schnappschuss`, async () => {
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-31T14:00', end_datetime: '2035-01-31T15:00',
      recurrence_rule: LAST_DAY, ...p.target,
    });
    await p.sync();
    assert.equal(row(event.id).outbound_snapshot, null);
    await p.sync();
    const r = row(event.id);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:00'));
    assert.equal(r.recurrence_rule.replace(/^RRULE:/, ''), LAST_DAY);
    assert.equal(r.series_authored, r.recurrence_rule === LAST_DAY && r.start_datetime === '2035-01-31T14:00' ? 1 : 0,
      'die Marke faellt wie bisher, sobald ein anderer Text in die Zeile kommt');
  });

  test(`${name} [${ZONE}] Kontrolle: eine Zeile von vor der Migration (kein Schnappschuss) nimmt den heutigen Weg`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    db.prepare('UPDATE calendar_events SET outbound_snapshot = NULL WHERE id = ?').run(s.id);
    await p.sync();
    const r = assertTaken(s);
    assert.equal(startMs(r.start_datetime), startMs('2035-01-31T14:00'));
    assert.notEqual(reminderOf(s.id), s.remindAt);
  });

  // ── Aus #1953 und #1957 ───────────────────────────────────────────────────
  test(`${name} [${ZONE}] Sekunden im eingelesenen Start: Regel in Yuvomi geaendert, das Echo laesst die Zeile`, async () => {
    const p = provider(name);
    p.seedForeign({ start: '2035-01-15T14:00:30', end: '2035-01-15T15:00:30', rrule: 'FREQ=MONTHLY' });
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
    await editTitle(p, imported.id, { recurrence_rule: LAST_DAY });
    const before = row(imported.id);
    assert.equal(before.series_authored, 1);
    await p.sync();
    const after = row(imported.id);
    assert.deepEqual(
      [after.start_datetime, after.end_datetime, after.tzid, after.recurrence_rule, after.series_authored],
      [before.start_datetime, before.end_datetime, before.tzid, before.recurrence_rule, 1],
    );
  });

  test(`${name} [${ZONE}] Kontrolle: Titel allein gespeichert (Formular laesst Start weg, #1966) - nichts verfasst`, async () => {
    const p = provider(name);
    const atProvider = p.seedForeign({ start: '2035-01-15T14:00', end: '2035-01-15T15:00', rrule: LAST_DAY });
    const held = atProvider();
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
    await editTitle(p, imported.id, { title: 'Nur der Titel' });
    assert.equal(row(imported.id).series_authored, 0);
    assert.deepEqual(atProvider(), held);
  });

  test(`${name} [${ZONE}] Kontrolle: Zonenwechsel an einer Zeile ohne Schnappschuss nimmt die Marke (#1957.1)`, async () => {
    const p = provider(name);
    const event = await post({
      title: 'Miete', start_datetime: '2035-01-31T14:00', end_datetime: '2035-01-31T15:00',
      recurrence_rule: LAST_DAY, ...p.target,
    });
    await p.sync();
    p.changeZoneAtProvider('America/New_York');
    await p.sync();
    assert.equal(row(event.id).tzid, 'America/New_York');
    assert.equal(row(event.id).series_authored, 0);
  });

  test(`${name} [${ZONE}] umsortierte Werteliste im PUT setzt die Marke nicht (#1957.2)`, async () => {
    const p = provider(name);
    const atProvider = p.seedForeign({
      start: '2035-01-15T14:00', end: '2035-01-15T15:00', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU;BYMONTHDAY=-1',
    });
    const held = atProvider();
    await p.sync();
    const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
    await editTitle(p, imported.id, { title: 'Umbenannt', recurrence_rule: 'FREQ=MONTHLY;BYDAY=TU,MO;BYMONTHDAY=-1' });
    assert.equal(row(imported.id).series_authored, 0, 'dieselbe Regel in anderer Reihenfolge ist keine Aenderung');
    assert.deepEqual(atProvider(), held, 'der eingelesene Start geht Wort fuer Wort zurueck');
  });
}

// ── Nur Google ──────────────────────────────────────────────────────────────

test(`Google [${ZONE}] Zone der Zeile und gesendete Zone verschieden: Echo in der gesendeten, New York zurueck ist ein Wechsel`, async () => {
  const p = provider('Google');
  p.seedForeign({
    start: '2035-01-15T23:30:00', end: '2035-01-15T23:45:00', rrule: 'FREQ=MONTHLY', zone: 'America/New_York',
  });
  await p.sync();
  const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
  assert.equal(imported.tzid, 'America/New_York');
  await editTitle(p, imported.id, { recurrence_rule: LAST_DAY });
  assert.equal(p.calendar.patches.at(-1).requestBody.start.timeZone, ZONE, 'Vorbedingung: gesendet in der Zone des Haushalts');
  const before = row(imported.id);
  await p.sync();
  const after = row(imported.id);
  assert.deepEqual(
    [after.start_datetime, after.end_datetime, after.tzid, after.recurrence_rule, after.series_authored],
    [before.start_datetime, before.end_datetime, 'America/New_York', LAST_DAY, 1],
    'das Echo in der gesendeten Zone laesst die Zeile',
  );

  // Der Anbieter stellt die Zone zurueck auf New York, dieselben Zeitpunkte.
  p.changeZoneAtProvider('America/New_York');
  await p.sync();
  const taken = row(imported.id);
  assert.equal(taken.tzid, 'America/New_York');
  assert.equal(taken.series_authored, 0, 'eine andere Zone als die gesendete ist ein Wechsel');
  assert.notEqual(taken.start_datetime, before.start_datetime, 'der Start des Anbieters kam in die Zeile');
});

test(`Google [${ZONE}] voller Abruf (ohne syncToken): Echo, kein Schreibvorgang`, async () => {
  const p = provider('Google');
  const s = await pushedSeries(p);
  await p.sync();
  assertKept(s);
  // Jeder Schreibvorgang des Abrufs an der Zeile setzt die SET-Liste; der
  // updated_at-Trigger schreibt nur seine eigene Spalte und zaehlt nicht mit.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS echo_writes (id INTEGER);
    DELETE FROM echo_writes;
    CREATE TEMP TRIGGER IF NOT EXISTS echo_write_probe AFTER UPDATE OF title, start_datetime ON calendar_events
      BEGIN INSERT INTO echo_writes VALUES (NEW.id); END;
  `);
  try {
    google.__test.recordSyncToken('family', null);
    await p.sync();
    assert.equal(p.calendar.inserts.length + p.calendar.patches.length, 1, 'Vorbedingung: nur der erste Upload');
    assertKept(s);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM echo_writes WHERE id = ?').get(s.id).n, 0,
      'der volle Abruf schreibt die Zeile nicht');
    // Die Sonde selbst: eine echte Aenderung beim Anbieter zaehlt sie.
    p.renameAtProvider('Miete (neu)');
    google.__test.recordSyncToken('family', null);
    await p.sync();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM echo_writes WHERE id = ?').get(s.id).n, 1,
      'die Sonde zaehlt einen Schreibvorgang');
    assertKept(s);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS echo_write_probe; DROP TABLE IF EXISTS echo_writes;');
  }
});

test(`Google [${ZONE}] Patch und Abruf im selben Lauf: das Echo des Patches`, async () => {
  const p = provider('Google');
  const s = await pushedSeries(p);
  // So merkt die Route eine Bearbeitung vor; der Lauf schickt sie und liest danach.
  db.prepare("UPDATE calendar_events SET title = 'Im Lauf', outbound_dirty = 1 WHERE id = ?").run(s.id);
  await p.sync();
  assert.equal(p.calendar.patches.length, 1, 'Vorbedingung: der Lauf hat gepatcht');
  assertKept(s);
  assert.equal(row(s.id).title, 'Im Lauf');
  assert.equal(row(s.id).outbound_dirty, 0);
});

test(`Google [${ZONE}] Bruchteile im eingelesenen Start: das Echo wird erkannt (#1957.3)`, async () => {
  const p = provider('Google');
  p.seedForeign({ start: '2035-01-15T13:00:00.500Z', end: '2035-01-15T14:00:00.500Z', rrule: 'FREQ=MONTHLY' });
  await p.sync();
  const imported = db.prepare("SELECT * FROM calendar_events WHERE title = 'Fremd'").get();
  assert.equal(imported.start_datetime, '2035-01-15T13:00:00.500Z', 'Vorbedingung: der Bruchteil steht in der Zeile');
  await editTitle(p, imported.id, { recurrence_rule: LAST_DAY });
  const before = row(imported.id);
  await p.sync();
  const after = row(imported.id);
  assert.deepEqual(
    [after.start_datetime, after.end_datetime, after.recurrence_rule, after.series_authored],
    [before.start_datetime, before.end_datetime, LAST_DAY, 1],
  );
});

// ── Nur CalDAV und iCloud ───────────────────────────────────────────────────

for (const name of ['CalDAV', 'iCloud']) {
  test(`${name} [${ZONE}] der Server schreibt die TZID um (anderer Name, dieselbe Uhr): der heutige Weg`, async () => {
    const p = provider(name);
    const s = await pushedSeries(p);
    p.changeZoneAtProvider(ALIAS);
    await p.sync();
    const r = assertTaken(s);
    assert.equal(r.tzid, ALIAS);
  });
}

// ── Migration 248 ───────────────────────────────────────────────────────────

test(`[${ZONE}] Migration 248 legt die Spalte an, Bestandszeilen bleiben NULL, ein zweiter Lauf scheitert nicht`, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const migration = dbmod.MIGRATIONS.find((m) => m.version === 248);
  assert.ok(migration, 'Migration 248 fehlt');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE calendar_events (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO calendar_events VALUES (1, 'Bestand');
    `);
    migration.up(database);
    assert.equal(database.prepare('SELECT outbound_snapshot FROM calendar_events WHERE id = 1').get().outbound_snapshot, null);
    migration.up(database);
  } finally { database.close(); }
});
