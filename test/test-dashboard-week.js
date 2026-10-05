/**
 * Modul: „Diese Woche" - der Wochenstreifen des Kalender-Widgets
 * Zweck: Der Kalender auf der Uebersicht zeigt in der Groesse 2x1 keine
 *        Terminliste, sondern sieben Tage ab heute mit einem Punkt je Termin
 *        und einem Band je ganztaegigem oder mehrtaegigem Termin. Diese Suite
 *        haelt fest:
 *          - die Tageszuordnung folgt der HAUSHALTSZONE, nicht dem Browser -
 *            auch fuer `eventOccurrenceDateKey()`, das bis hierher
 *            synchronisierte Termine in der Browser-Zone las
 *          - ein Termin um 23:30 Haushaltszeit bleibt auf seinem Tag, auch
 *            ueber einen Sommerzeitwechsel innerhalb der Woche
 *          - mehrtaegige Termine werden ein Band mit Rand-Kennzeichnung
 *          - der Renderer zeigt sieben Tage, heute markiert, je Tag ein Link
 *            auf die Tagesansicht des Kalenders
 *          - die Daten kommen ueber /dashboard mit denselben Rechten und
 *            Optionen wie die Terminliste (Modul gesperrt, Token-Scope,
 *            „nur meine", Geburtstage ab, Sichtbarkeit)
 *
 * DIE BROWSER-ZONE IST HIER ABSICHTLICH EINE ANDERE ALS DIE DES HAUSHALTS.
 * In der UTC-CI fallen alle drei Zonen zusammen, und ein Test ohne eigene
 * Vorgabe waere dort gruen und blind (dieselbe Lehre wie
 * test-calendar-timezone-window.js). Tokio liegt sieben Stunden oestlich von
 * Berlin: ein Termin um 23:30 Berliner Zeit ist dort schon der Folgetag.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-dashboard-week.js
 */
process.env.TZ = 'Asia/Tokyo';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dashboard-week-test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

const HOUSEHOLD = 'Europe/Berlin';

// --------------------------------------------------------------------------
// Teil 1: Tageszuordnung im Browser
// --------------------------------------------------------------------------

/* Ueber DENSELBEN Spezifizierer, den dashboard.js benutzt - nur so trifft
 * `setDisplayTimeZone` den Zonen-Cache, aus dem die Seite liest. */
const tz = await import('/utils/timezone.js');
const { __test: dash } = await import('../public/pages/dashboard.js');
// Tolerant geladen: fehlt das Modul, sollen die Tests EINZELN rot werden und
// nicht die ganze Datei beim Import - sonst waere Teil 1 nie gegen den
// unveraenderten Stand gelaufen.
const { buildWeekStrip } = await import('/utils/week-strip.js').catch(() => ({}));

function withHouseholdZone(fn) {
  tz.setDisplayTimeZone(HOUSEHOLD);
  try { return fn(); } finally { tz.setDisplayTimeZone(null); }
}

test('Vorbedingung: Browser und Haushalt liegen in verschiedenen Zonen', () => {
  // Ohne diese Probe koennte die Suite in einer Umgebung laufen, in der
  // `process.env.TZ` nicht greift - dann waere jede Zusicherung unten gruen,
  // weil Browser und Haushalt denselben Tag sehen.
  const instant = new Date('2026-09-24T21:30:00Z');
  assert.equal(instant.getDate(), 25, 'in Tokio ist 21:30Z schon der naechste Tag');
});

test('eventOccurrenceDateKey liest einen synchronisierten Termin in der Haushaltszone', () => {
  withHouseholdZone(() => {
    // 23:30 in Berlin (CEST) - in Tokio bereits 06:30 am 25.
    assert.equal(dash.eventOccurrenceDateKey({ start_datetime: '2026-09-24T21:30:00Z' }), '2026-09-24');
    // Mit Offset statt Z: dieselbe Frage, dieselbe Antwort.
    assert.equal(dash.eventOccurrenceDateKey({ start_datetime: '2026-09-24T23:30:00+02:00' }), '2026-09-24');
    // Zonenlose Wanduhrzeit ist bereits die Antwort und wird nur gelesen.
    assert.equal(dash.eventOccurrenceDateKey({ start_datetime: '2026-09-24T23:30' }), '2026-09-24');
    assert.equal(dash.eventOccurrenceDateKey({ start_datetime: '2026-09-24' }), '2026-09-24');
  });
});

test('calendarEventRoute verlinkt den Tag der Haushaltszone', () => {
  withHouseholdZone(() => {
    const route = dash.calendarEventRoute({ id: 7, start_datetime: '2026-09-24T21:30:00Z' });
    assert.equal(new URLSearchParams(route.split('?')[1]).get('date'), '2026-09-24');
  });
});

test('Ohne gesetzte Haushaltszone bleibt es beim Browser (Verhalten vor #829)', () => {
  tz.setDisplayTimeZone(null);
  assert.equal(dash.eventOccurrenceDateKey({ start_datetime: '2026-09-24T21:30:00Z' }), '2026-09-25');
});

// --------------------------------------------------------------------------
// Teil 2: das Modell des Streifens
// --------------------------------------------------------------------------

const keysOf = (strip) => strip.days.map((d) => d.key);
const dotIds = (strip, key) => strip.days.find((d) => d.key === key).dots.map((dot) => dot.id);

test('sieben Tage ab dem Bezugstag, der erste ist heute', () => {
  const strip = buildWeekStrip([], '2026-09-28', { timeZone: HOUSEHOLD });
  assert.deepEqual(keysOf(strip), [
    '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  ]);
  assert.deepEqual(strip.days.map((d) => d.isToday), [true, false, false, false, false, false, false]);
  // Wochentag aus dem Schluessel: 28.09.2026 ist ein Montag (0 = Sonntag).
  assert.deepEqual(strip.days.map((d) => d.weekday), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(strip.days.map((d) => d.dayOfMonth), [28, 29, 30, 1, 2, 3, 4]);
});

test('ein Termin um 23:30 Haushaltszeit bleibt auf seinem Tag', () => {
  const strip = buildWeekStrip([
    { id: 1, start_datetime: '2026-09-24T21:30:00Z', end_datetime: '2026-09-24T22:00:00Z' },
    { id: 2, start_datetime: '2026-09-24T23:30', end_datetime: '2026-09-24T23:55' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  assert.deepEqual(dotIds(strip, '2026-09-24'), [1, 2]);
  assert.deepEqual(dotIds(strip, '2026-09-25'), []);
});

test('Sommerzeitwechsel in der Woche: 23:30 bleibt vor und nach der Umstellung auf seinem Tag', () => {
  // Europe/Berlin stellt am 25.10.2026 von +02:00 auf +01:00 um. Ein fester
  // Versatz aus dem Wochenanfang (+02:00) legte den Termin am 26. auf den 27.
  const strip = buildWeekStrip([
    { id: 'vorher', start_datetime: '2026-10-23T21:30:00Z' },   // 23:30 CEST am 23.
    { id: 'nachher', start_datetime: '2026-10-26T22:30:00Z' },  // 23:30 CET am 26.
    { id: 'frueh', start_datetime: '2026-10-24T22:30:00Z' },    // 00:30 CEST am 25.
  ], '2026-10-22', { timeZone: HOUSEHOLD });
  assert.deepEqual(dotIds(strip, '2026-10-23'), ['vorher']);
  assert.deepEqual(dotIds(strip, '2026-10-26'), ['nachher']);
  assert.deepEqual(dotIds(strip, '2026-10-27'), []);
  assert.deepEqual(dotIds(strip, '2026-10-25'), ['frueh']);
});

test('Termine ausserhalb der sieben Tage fallen heraus', () => {
  const strip = buildWeekStrip([
    { id: 'gestern', start_datetime: '2026-09-22T10:00' },
    { id: 'acht', start_datetime: '2026-09-30T10:00' },
    { id: 'sieben', start_datetime: '2026-09-29T10:00' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  assert.deepEqual(strip.days.flatMap((d) => d.dots.map((dot) => dot.id)), ['sieben']);
  assert.deepEqual(strip.bands, []);
});

test('ein Zeittermin, der exakt um Mitternacht endet, belegt den Folgetag nicht', () => {
  const strip = buildWeekStrip([
    { id: 1, start_datetime: '2026-09-24T21:00', end_datetime: '2026-09-25T00:00' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  assert.deepEqual(dotIds(strip, '2026-09-24'), [1]);
  assert.deepEqual(dotIds(strip, '2026-09-25'), []);
});

test('ein kurzer Nachttermin ist ein Punkt an beiden Tagen, kein Band', () => {
  const strip = buildWeekStrip([
    { id: 1, start_datetime: '2026-09-24T22:00', end_datetime: '2026-09-25T01:30' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  assert.deepEqual(dotIds(strip, '2026-09-24'), [1]);
  assert.deepEqual(dotIds(strip, '2026-09-25'), [1]);
  assert.deepEqual(strip.bands, []);
});

test('mehrtaegige Termine werden ein Band - am Rand gekennzeichnet, wenn sie weiterlaufen', () => {
  const strip = buildWeekStrip([
    // Ganztaegig, Ende INKLUSIV (so speichert es der Kalender): 22.-25.09.
    { id: 'reise', all_day: 1, start_datetime: '2026-09-22', end_datetime: '2026-09-25T00:00' },
    // Zeittermin ueber mehr als 24 Stunden, laeuft ueber das Fensterende.
    { id: 'kur', start_datetime: '2026-09-28T09:00', end_datetime: '2026-10-02T17:00' },
    // Ein einzelner ganztaegiger Tag ist ebenfalls ein Band, nur ein kurzes.
    { id: 'feiertag', all_day: 1, start_datetime: '2026-09-26', end_datetime: '2026-09-26' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  const band = (id) => strip.bands.find((b) => b.id === id);
  assert.deepEqual(
    { start: band('reise').startIndex, end: band('reise').endIndex, before: band('reise').continuesBefore, after: band('reise').continuesAfter },
    { start: 0, end: 2, before: true, after: false },
  );
  assert.deepEqual(
    { start: band('kur').startIndex, end: band('kur').endIndex, before: band('kur').continuesBefore, after: band('kur').continuesAfter },
    { start: 5, end: 6, before: false, after: true },
  );
  assert.deepEqual([band('feiertag').startIndex, band('feiertag').endIndex], [3, 3]);
  // Ein Band ist kein Punkt: derselbe Termin wird nicht doppelt gezaehlt.
  assert.deepEqual(strip.days.flatMap((d) => d.dots), []);
  // Aber der Tag weiss, dass an ihm etwas stattfindet.
  assert.deepEqual(strip.days.map((d) => d.count), [1, 1, 1, 1, 0, 1, 1]);
});

test('Baender teilen sich Spuren; was keine Spur mehr bekommt, zaehlt am Tag mit', () => {
  const strip = buildWeekStrip([
    { id: 'a', all_day: 1, start_datetime: '2026-09-23', end_datetime: '2026-09-29' },
    { id: 'b', all_day: 1, start_datetime: '2026-09-24', end_datetime: '2026-09-25' },
    { id: 'c', all_day: 1, start_datetime: '2026-09-25', end_datetime: '2026-09-26' },
    { id: 'd', all_day: 1, start_datetime: '2026-09-27', end_datetime: '2026-09-27' },
  ], '2026-09-23', { timeZone: HOUSEHOLD, maxLanes: 2 });
  const lane = Object.fromEntries(strip.bands.map((b) => [b.id, b.lane]));
  assert.equal(lane.a, 0, 'das laengste Band nimmt die erste Spur');
  assert.equal(lane.b, 1);
  assert.equal(lane.d, 1, 'd passt hinter b in dieselbe Spur');
  assert.equal(lane.c, undefined, 'c ueberschneidet a UND b und bekommt keine Spur');
  assert.equal(strip.laneCount, 2);
  const day = (key) => strip.days.find((d) => d.key === key);
  assert.equal(day('2026-09-25').more, 1, 'am 25. steht ein verdecktes Band');
  assert.equal(day('2026-09-26').more, 1);
  assert.equal(day('2026-09-24').more, 0);
});

test('Punkte tragen die Farbe von Termin, Person oder Kalender - dieselbe Regel wie der Kalender', () => {
  const strip = buildWeekStrip([
    { id: 1, start_datetime: '2026-09-23T09:00', color: '#112233' },
    { id: 2, start_datetime: '2026-09-23T10:00', assigned_to: 5, assigned_users: [{ id: 5, color: '#445566' }], cal_color: '#778899' },
    { id: 3, start_datetime: '2026-09-23T11:00', cal_color: '#778899' },
  ], '2026-09-23', { timeZone: HOUSEHOLD });
  assert.deepEqual(strip.days[0].dots.map((d) => d.color), ['#112233', '#445566', '#778899']);
});

test('Punkte stehen in zeitlicher Reihenfolge, zu viele werden als Rest gezaehlt', () => {
  const events = [5, 3, 1, 4, 2, 6, 7, 8].map((h) => ({ id: h, start_datetime: `2026-09-23T0${h}:00` }));
  const strip = buildWeekStrip(events, '2026-09-23', { timeZone: HOUSEHOLD, maxDots: 6 });
  assert.deepEqual(strip.days[0].dots.map((d) => d.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(strip.days[0].more, 2);
  assert.equal(strip.days[0].count, 8);
});

// --------------------------------------------------------------------------
// Teil 3: der Renderer
// --------------------------------------------------------------------------

function todayKeyInHousehold() {
  return withHouseholdZone(() => tz.todayKey());
}

test('2x1 zeigt den Wochenstreifen: sieben Tage, heute markiert, jeder Tag fuehrt in die Tagesansicht', () => {
  const html = withHouseholdZone(() => dash.renderCalendarWidget({ upcomingEvents: [], weekEvents: [] }, '2x1'));
  const days = [...html.matchAll(/<a [^>]*class="week-strip__day[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(days.length, 7, `sieben Tage erwartet, erhalten ${days.length}`);
  assert.equal(days.filter((d) => /aria-current="date"/.test(d)).length, 1, 'genau ein Tag ist heute');
  assert.match(days[0], /week-strip__day--today/, 'heute steht vorn');
  assert.match(days[0], new RegExp(`href="/calendar\\?date=${todayKeyInHousehold()}"`));
  for (const day of days) assert.match(day, /data-route="\/calendar\?date=\d{4}-\d{2}-\d{2}"/);
  assert.doesNotMatch(html, /event-item/, 'keine Terminliste');
});

test('die anderen Groessen bleiben die Terminliste', () => {
  const events = [{ id: 1, title: 'Zahnarzt', start_datetime: `${todayKeyInHousehold()}T14:00` }];
  for (const size of ['1x1', '1x2', '2x2']) {
    const html = withHouseholdZone(() => dash.renderCalendarWidget({ upcomingEvents: events, weekEvents: events }, size));
    assert.match(html, /event-item/, `${size}: Liste erwartet`);
    assert.doesNotMatch(html, /week-strip/, `${size}: kein Streifen`);
  }
});

test('ein Termin erscheint als Punkt an seinem Tag und nennt sich im Tagesnamen', () => {
  const today = todayKeyInHousehold();
  const html = withHouseholdZone(() => dash.renderCalendarWidget({
    upcomingEvents: [],
    weekEvents: [
      { id: 1, title: 'Zahnarzt <b>', start_datetime: `${today}T14:00`, color: '#112233' },
      { id: 2, title: 'Ferien', all_day: 1, start_datetime: today, end_datetime: today },
    ],
  }, '2x1'));
  assert.match(html, /class="week-strip__dot"[^>]*style="--dot-color:#112233"/);
  assert.match(html, /class="week-strip__band[^"]*"/);
  assert.doesNotMatch(html, /Zahnarzt <b>/, 'Titel laufen durch esc()');
  // Die Anzahl steht im zugaenglichen Namen des Tages (Stub-t liefert Schluessel + Werte).
  assert.match(html, /dashboard\.weekDayEvents\{&quot;count&quot;:2\}/);
});

test('ohne Wochendaten (gesperrtes Modul, alte Antwort) bleibt der Streifen stehen, nur leer', () => {
  const html = withHouseholdZone(() => dash.renderCalendarWidget({ upcomingEvents: [] }, '2x1'));
  assert.equal((html.match(/class="week-strip__day/g) ?? []).length, 7);
  assert.doesNotMatch(html, /week-strip__dot"/);
});

test('der Kalender kennt den Tag-Link: /calendar?date= ohne Termin oeffnet diesen Tag', async () => {
  const { __test: cal } = await import('../public/pages/calendar.js');
  assert.equal(typeof cal.dayDeepLinkDate, 'function', 'der Kalender liest date nur zusammen mit open');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('date=2026-09-24')), '2026-09-24');
  // Mit Termin bleibt es der bestehende Termin-Link (Vorkommen dieses Tages).
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('open=7&date=2026-09-24')), '');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('date=24.09.2026')), '');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('')), '');
});

// --------------------------------------------------------------------------
// Teil 4: die Daten ueber /dashboard - Rechte und Optionen
// --------------------------------------------------------------------------

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { todayKey: serverTodayKey, shiftDateKey, localToUTC } = await import('../server/utils/timezone.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const database = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(database);
moduleDatabase.close();

database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(HOUSEHOLD);

function seedUser(prefix, role = 'member') {
  return Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid);
}

const ADMIN = seedUser('week-admin', 'admin');
const KID = seedUser('week-kid');

const TODAY = serverTodayKey(database);
const insertEvent = database.prepare(`
  INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, visibility, created_by, assigned_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function addEvent({ title, start, end = null, allDay = 0, visibility = 'all', by = ADMIN, assignees = [] }) {
  const id = Number(insertEvent.run(title, `Beschreibung ${title}`, start, end, allDay, visibility, by, assignees[0] ?? null).lastInsertRowid);
  for (const userId of assignees) {
    database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, userId);
  }
  return id;
}

// Heute 23:30 Haushaltszeit, gespeichert als Instant (synchronisiert).
addEvent({ title: 'Spaet heute', start: localToUTC(`${TODAY}T23:30:00`, HOUSEHOLD), assignees: [KID] });
addEvent({ title: 'In drei Tagen', start: `${shiftDateKey(TODAY, 3)}T10:00`, assignees: [ADMIN] });
addEvent({ title: 'Reise', start: shiftDateKey(TODAY, -2), end: `${shiftDateKey(TODAY, 1)}T00:00`, allDay: 1 });
addEvent({ title: 'Nach der Woche', start: `${shiftDateKey(TODAY, 12)}T10:00` });
addEvent({ title: 'Letzte Woche', start: `${shiftDateKey(TODAY, -5)}T10:00` });
addEvent({ title: 'Privat vom Admin', start: `${shiftDateKey(TODAY, 2)}T10:00`, visibility: 'private' });
const birthdayEventId = addEvent({ title: 'Birthday: Oma', start: shiftDateKey(TODAY, 4), end: shiftDateKey(TODAY, 4), allDay: 1 });
database.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)')
  .run('Oma', '1950-01-01', birthdayEventId, ADMIN);
// Ein woechentlicher Termin, dessen Serie vor Wochen begann.
database.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES ('Turnen', ?, ?, 0, 'all', ?, 'FREQ=WEEKLY')
`).run(`${shiftDateKey(TODAY, -27)}T17:00`, `${shiftDateKey(TODAY, -27)}T18:00`, ADMIN);

let actor = ADMIN;
let tokenScopes = null;
const app = express();
app.use((req, _res, next) => {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(database, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

async function dashboardAs(userId, query = '') {
  actor = userId;
  const response = await fetch(`${endpoint}${query}`);
  assert.equal(response.status, 200);
  return response.json();
}
const titles = (body) => body.weekEvents.map((e) => e.title).sort();

test('/dashboard liefert die Termine der Woche - auch den ueberlappenden und die Serie', async () => {
  const body = await dashboardAs(ADMIN);
  assert.ok(Array.isArray(body.weekEvents), 'weekEvents fehlt in der Antwort');
  const got = titles(body);
  for (const title of ['Spaet heute', 'In drei Tagen', 'Reise', 'Privat vom Admin', 'Birthday: Oma', 'Turnen']) {
    assert.ok(got.includes(title), `${title} fehlt: ${got.join(', ')}`);
  }
  assert.ok(!got.includes('Nach der Woche'), 'zwoelf Tage voraus gehoert nicht in die Woche');
  assert.ok(!got.includes('Letzte Woche'), 'vergangene Termine gehoeren nicht in die Woche');
  const turnen = body.weekEvents.filter((e) => e.title === 'Turnen');
  assert.equal(turnen.length, 1, 'eine woechentliche Serie hat in sieben Tagen genau ein Vorkommen');
});

test('die Wochendaten sind schlank: keine Beschreibung, keine Anhaenge', async () => {
  const body = await dashboardAs(ADMIN);
  const event = body.weekEvents.find((e) => e.title === 'In drei Tagen');
  assert.equal(event.description, undefined);
  assert.equal(event.attachment_name, undefined);
  assert.ok(event.start_datetime && 'all_day' in event && Array.isArray(event.assigned_users));
});

test('Sichtbarkeit: ein privater Termin eines anderen erscheint nicht', async () => {
  const got = titles(await dashboardAs(KID));
  assert.ok(got.includes('Spaet heute'), `Vorbedingung: das Kind sieht die Woche - ${got.join(', ')}`);
  assert.ok(!got.includes('Privat vom Admin'), 'privater Termin durchgerutscht');
});

test('events_scope=mine gilt auch fuer die Woche', async () => {
  const got = titles(await dashboardAs(KID, '?events_scope=mine'));
  assert.deepEqual(got, ['Spaet heute']);
});

test('events_birthdays=hide gilt auch fuer die Woche', async () => {
  const got = titles(await dashboardAs(ADMIN, '?events_birthdays=hide'));
  assert.ok(!got.includes('Birthday: Oma'));
  assert.ok(got.includes('Reise'), 'ein normaler Ganztagstermin bleibt');
});

test('gesperrter Kalender: die Woche ist leer, die Form bleibt', async () => {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'none')
  `).run(String(KID));
  try {
    const body = await dashboardAs(KID);
    assert.deepEqual(body.weekEvents, []);
    assert.ok(!JSON.stringify(body).includes('Spaet heute'));
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(KID));
  }
});

test('nur-lesend darf die Woche lesen', async () => {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'read')
  `).run(String(KID));
  try {
    assert.ok(titles(await dashboardAs(KID)).includes('Spaet heute'));
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(KID));
  }
});

test('ein Token ohne Kalender-Scope bekommt keine Woche', async () => {
  tokenScopes = ['dashboard:read'];
  try {
    const body = await dashboardAs(ADMIN);
    assert.deepEqual(body.weekEvents, []);
  } finally {
    tokenScopes = null;
  }
});
