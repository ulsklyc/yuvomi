/**
 * Modul: Uebersicht - was heute ist (Server)
 * Zweck: Die Stellen, an denen GET /dashboard „heute" und „diesen Monat"
 *        anders zaehlte als der Haushalt sie erlebt, jede gegen den echten
 *        Router und eine migrierte In-Memory-DB, mit festgenagelter Uhr und
 *        Haushaltszone (Berlin wie die Demo-Saat) und je einem Gegenlauf in
 *        einer Zone, die den Tag oder den Monat verschiebt:
 *
 *        1. Haushaltshilfe (#1451): Besuche und offener Betrag des Monats
 *           zaehlten den UTC-Monat von `check_in` (`substr(check_in, 1, 7)`).
 *        2. Mehrtaegige Termine (#1457): `upcomingEvents` waehlte nach dem
 *           BEGINN, und was gestern begann und heute noch laeuft, fehlte in
 *           Liste, Heute-Blatt, Wand und Familienkarte.
 *        3. Familienkarte (#1449): sie lieh sich die Liste der Termin-Kachel
 *           - fuenf Kommende und deren „nur meine" - und verlor damit den
 *           Abendtermin eines Mitglieds an einem vollen Tag.
 *        4. „Heute bis HH:MM" (#1534): die Faelligkeit einer Aufgabe wurde
 *           in der Zone des Geraets gelesen und dann in die des Haushalts
 *           umgerechnet - hier mit Prozesszone != Haushaltszone.
 *
 * Ausfuehren: npm run test:dashboard-today
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-today-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

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
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const ADMIN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Anna', 'hash', '#7C3AED', 'admin', 'parent')
`).run(`today-admin-${randomUUID()}`).lastInsertRowid;

const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(ADMIN);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/housekeeping', housekeepingRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
}

// Die Uhr steht fest; nur `Date` wird gemockt, die Timer des HTTP-Servers
// laufen weiter. Die Zone ist die des HAUSHALTS (sync_config), nicht die des
// Rechners - die Suite laeuft in jeder Maschinenzone gleich.
function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

// --------------------------------------------------------------------------
// 1. Haushaltshilfe: der Monat des Haushalts (#1451)
// --------------------------------------------------------------------------

const HELPER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Maria', 'hash', '#34C759', 'member')
`).run(`today-helper-${randomUUID()}`).lastInsertRowid;
const WORKER = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)').run(HELPER).lastInsertRowid;

// `check_in` in der Form, die der Check-in schreibt: `toISOString()`.
function seedVisit(checkIn, checkOut, { rate = 40, extras = 0, paid = false } = {}) {
  db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, paid_at, worker_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(checkIn, checkOut, rate, extras, paid ? checkOut : null, WORKER, ADMIN);
}
const clearVisits = () => db.prepare('DELETE FROM housekeeping_work_sessions').run();

test('#1451 Berlin: ein Besuch am Ersten um 00:30 zaehlt in diesem Monat, nicht im Vormonat',
  withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
    clearVisits();
    // 01.10. 00:30 bis 03:30 in Berlin - als Instant noch der 30.09.
    seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z', { extras: 10 });
    // Kontrolle: ein Besuch mitten im September zaehlt nicht.
    seedVisit('2026-09-15T07:00:00.000Z', '2026-09-15T11:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'der Besuch vom 01.10. ist ein Oktober-Besuch');
    assert.equal(housekeeping.unpaidAmount, 50, 'daily_rate 40 + extras 10 im Oktober');
  }));

test('#1451 Los Angeles: ein Besuch am Letzten abends zaehlt in diesem Monat, nicht im naechsten',
  withClock('2026-10-01T03:00:00Z', 'America/Los_Angeles', async () => {
    clearVisits();
    // 30.09. 18:00 bis 21:00 in Los Angeles - als Instant schon der 01.10.
    seedVisit('2026-10-01T01:00:00.000Z', '2026-10-01T04:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'es ist noch September - der Besuch gehoert dazu');
    assert.equal(housekeeping.unpaidAmount, 40);
  }));

test('#1451: zonenlose Wanduhrzeit zaehlt in ihrem eigenen Monat', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  // Beide Formen, die `check_in` tragen kann (householdMonthOf im Modul):
  // zonenlos steht die Ziffernfolge schon in der Haushaltszone.
  seedVisit('2026-10-01T00:30:00', '2026-10-01T03:30:00');
  seedVisit('2026-09-30T23:30:00', '2026-10-01T01:00:00');
  const { housekeeping } = await getJson('/');
  assert.equal(housekeeping.visitsThisMonth, 1, 'nur der Besuch vom 01.10. gehoert in den Oktober');
}));

test('#1451: Uebersicht und Modul zaehlen dieselben abgeschlossenen Besuche', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z');
  seedVisit('2026-10-01T05:00:00.000Z', '2026-10-01T07:00:00.000Z', { paid: true });
  seedVisit('2026-09-30T20:00:00.000Z', '2026-09-30T21:30:00.000Z'); // 22:00 Berlin, noch September
  const { housekeeping } = await getJson('/');
  const module = (await getJson('/housekeeping/dashboard')).data;
  assert.equal(module.visits_this_month, 2, 'Vorbedingung: das Modul zaehlt zwei Oktober-Besuche');
  assert.equal(housekeeping.visitsThisMonth, module.visits_this_month, 'Uebersicht und Modul sagen dieselbe Zahl');
}));

// --------------------------------------------------------------------------
// 2. Was gestern begann und heute laeuft (#1457)
// --------------------------------------------------------------------------

const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES (?, ?, ?, ?, 'all', ?, ?)
`);
function addEvent(title, start, end = null, { allDay = 0, rrule = null } = {}) {
  return Number(insertEvent.run(title, start, end, allDay, ADMIN, rrule).lastInsertRowid);
}
const clearEvents = () => db.prepare('DELETE FROM calendar_events').run();
const titles = (events) => events.map((e) => e.title);

// Donnerstag, 24.09.2026, 10:00 in Berlin.
const THU_10_BERLIN = '2026-09-24T08:00:00Z';

test('#1457: laufende mehrtaegige Termine stehen heute in upcomingEvents', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Reise', '2026-09-23T18:00', '2026-09-25T12:00');
  addEvent('Klassenfahrt', '2026-09-23', '2026-09-25', { allDay: 1 });
  addEvent('Synchronisiert', '2026-09-23T16:00:00.000Z', '2026-09-25T10:00:00.000Z');
  addEvent('Nachtschicht', '2026-09-23T18:00', '2026-09-24T08:00');
  addEvent('Gestern vorbei', '2026-09-23T10:00', '2026-09-23T12:00');
  addEvent('Ganztag gestern', '2026-09-23', '2026-09-23', { allDay: 1 });
  addEvent('Heute abend', '2026-09-24T19:00', '2026-09-24T20:00');
  const { upcomingEvents } = await getJson('/');
  const got = titles(upcomingEvents);
  for (const title of ['Reise', 'Klassenfahrt', 'Synchronisiert', 'Nachtschicht', 'Heute abend']) {
    assert.ok(got.includes(title), `${title} fehlt in upcomingEvents: ${got.join(', ')}`);
  }
  for (const title of ['Gestern vorbei', 'Ganztag gestern']) {
    assert.ok(!got.includes(title), `${title} ist gestern zu Ende und gehoert nicht in heute: ${got.join(', ')}`);
  }
}));

test('#1457: der Deckel von fuenf zaehlt den laufenden Termin, nicht den heute beendeten', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Nachtschicht', '2026-09-23T18:00', '2026-09-24T08:00');
  for (let i = 1; i <= 5; i += 1) addEvent(`Kommt ${i}`, `2026-09-24T1${i}:00`, `2026-09-24T1${i}:30`);
  const { upcomingEvents } = await getJson('/');
  const got = titles(upcomingEvents);
  assert.deepEqual(got, ['Nachtschicht', 'Kommt 1', 'Kommt 2', 'Kommt 3', 'Kommt 4', 'Kommt 5'],
    'die heute beendete Nachtschicht steht ausserhalb des Deckels, alle fuenf kommenden bleiben');
}));

test('#1457: auch das Vorkommen einer Serie, das gestern begann, laeuft heute', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  // Taeglich 23:00 bis 11:00 am Folgetag: das Vorkommen von gestern laeuft um 10:00 noch.
  addEvent('Bereitschaft', '2026-09-20T23:00', '2026-09-21T11:00', { rrule: 'FREQ=DAILY' });
  const { upcomingEvents } = await getJson('/');
  const starts = upcomingEvents.filter((e) => e.title === 'Bereitschaft').map((e) => String(e.start_datetime).slice(0, 16));
  assert.ok(starts.includes('2026-09-23T23:00'), `das laufende Vorkommen von gestern fehlt: ${starts.join(', ')}`);
  assert.ok(starts.includes('2026-09-24T23:00'), 'und das von heute Abend steht weiter da');
}));

test('#1457: ob ein Termin in heute reicht, entscheidet die Haushaltszone', async () => {
  // Endet um 01:00Z: in Berlin nach Mitternacht (03:00) - heute beendet; in
  // Los Angeles am Vortag um 18:00, also gestern vorbei.
  const setup = () => {
    clearEvents();
    addEvent('Ueber Mitternacht', '2026-09-23T16:00:00.000Z', '2026-09-24T01:00:00.000Z');
  };
  await withClock('2026-09-24T15:00:00Z', 'Europe/Berlin', async () => {
    setup();
    assert.ok(titles((await getJson('/')).upcomingEvents).includes('Ueber Mitternacht'), 'Berlin: heute beendet, steht da');
  })();
  await withClock('2026-09-24T15:00:00Z', 'America/Los_Angeles', async () => {
    setup();
    assert.ok(!titles((await getJson('/')).upcomingEvents).includes('Ueber Mitternacht'), 'Los Angeles: gestern vorbei');
  })();
});

test('#1457: /calendar/upcoming und MCP (ohne fromToday) bleiben „ab jetzt"', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Reise', '2026-09-23T18:00', '2026-09-25T12:00');
  addEvent('Heute abend', '2026-09-24T19:00', '2026-09-24T20:00');
  assert.deepEqual(titles(getUpcomingEvents(db, { userId: ADMIN, limit: 5 })), ['Heute abend']);
}));

// --- dieselben Termine im Browser: Kachel, Tagesprogramm, Familienkarte ---

const tz = await import('/utils/timezone.js');
const { __test: dash } = await import('../public/pages/dashboard.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

function inBrowser(iso, zone, fn) {
  return async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    tz.setDisplayTimeZone(zone);
    const prevWindow = global.window;
    global.window = { yuvomi: { isModuleDisabled: () => false } };
    setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
    try {
      await fn();
    } finally {
      clearPermissions();
      global.window = prevWindow;
      tz.setDisplayTimeZone(null);
      mock.timers.reset();
    }
  };
}

const KID = { id: 91, display_name: 'Leo', avatar_color: '#FF9500' };
const ev = (id, title, start, end, extra = {}) => ({
  id, title, start_datetime: start, end_datetime: end, all_day: 0, assigned_users: [], ...extra,
});
// Wie die Antwort sie liefert: sortiert nach Beginn.
const BERLIN_DAY = [
  ev(1, 'Reise', '2026-09-23T18:00', '2026-09-25T12:00'),
  ev(2, 'Nachtschicht', '2026-09-23T18:00', '2026-09-24T08:00'),
  ev(3, 'Heimweg', '2026-09-23T20:00', '2026-09-24T12:00'),
  ev(4, 'Klassenfahrt', '2026-09-23', '2026-09-25', { all_day: 1 }),
  ev(5, 'Heute abend', '2026-09-24T19:00', '2026-09-24T20:00'),
];

function tileRows(html) {
  return [...html.matchAll(/<div class="event-item([^"]*)"[\s\S]*?event-item__title">([^<]*)<\/div>[\s\S]*?event-item__time">([\s\S]*?)<\/div>/g)]
    .map(([, cls, title, time]) => ({
      title,
      ended: cls.includes('event-item--ended'),
      badge: (/event-time-badge[^>]*>([^<]*)</.exec(time) || [])[1],
      time: time.replace(/<span[^>]*>[^<]*<\/span>/g, '').replace(/\s+/g, ' ').trim(),
    }));
}

test('#1457 Kachel: ein Termin von gestern steht heute, mit „ganztaegig" oder „bis"', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const rows = tileRows(dash.renderUpcomingEvents(BERLIN_DAY, { now: new Date() }));
  const by = Object.fromEntries(rows.map((row) => [row.title, row]));
  assert.deepEqual(by.Reise, { title: 'Reise', ended: false, badge: 'common.today', time: 'dashboard.allDay' },
    'laeuft ueber heute hinaus: heute, ohne die Startzeit von gestern');
  assert.deepEqual(by.Klassenfahrt, { title: 'Klassenfahrt', ended: false, badge: 'common.today', time: 'dashboard.allDay' });
  assert.deepEqual(by.Heimweg, { title: 'Heimweg', ended: false, badge: 'common.today', time: 'dashboard.todayUntil{"time":"2026-09-24T12:00"}' },
    'endet heute: „bis 12:00"');
  assert.equal(by.Nachtschicht?.ended, true, 'heute um 08:00 zu Ende: tritt zurueck wie jeder heute beendete Termin');

  // Ein Ende um genau 00:00 schliesst den Tag davor (#804): die Reise bis
  // heute Mitternacht endet heute, sie laeuft morgen nicht weiter.
  const [midnight] = tileRows(dash.renderUpcomingEvents([ev(9, 'Bis Mitternacht', '2026-09-23T18:00', '2026-09-25T00:00')], { now: new Date() }));
  assert.equal(midnight.time, 'dashboard.todayUntil{"time":"2026-09-25T00:00"}');
}));

test('#1457 Heute-Blatt: der laufende Termin steht oben, der beendete nicht', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const program = dash.buildTodayProgram({ upcomingEvents: BERLIN_DAY }, { includeTasks: false, includeMeals: false, now: new Date() });
  const rows = program.rows.map((row) => [row.title, row.sortKey, row.timeLabel]);
  assert.deepEqual(rows, [
    ['Reise', '00:01', 'dashboard.allDay'],
    ['Heimweg', '00:01', 'dashboard.todayUntil{"time":"2026-09-24T12:00"}'],
    ['Klassenfahrt', '00:01', 'dashboard.allDay'],
    ['Heute abend', '19:00', '2026-09-24T19:00'],
  ]);
  assert.equal(dash.buildTodayHighlights({ upcomingEvents: BERLIN_DAY }).eventCount, 5, '„Heute auf einen Blick" zaehlt alle fuenf von heute');
}));

test('#1457 Familienkarte: wer auf Reise ist, ist nicht „heute frei"', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const events = [ev(1, 'Reise', '2026-09-23T18:00', '2026-09-25T12:00', { assigned_users: [{ id: KID.id }] })];
  const html = dash.renderFamilyWidget([KID], { upcomingEvents: events, familyEvents: events });
  const status = (/family-member__status[^"]*">([^<]*)</.exec(html) || [])[1];
  assert.equal(status, 'Reise', `die laufende Reise ist der Termin von heute, bekam ${status}`);
}));

test('#1457: im Browser entscheidet die Haushaltszone, nicht die Geraetezone', inBrowser('2026-09-24T20:00:00Z', 'Pacific/Honolulu', () => {
  // 10:00 in Honolulu. Beide als Instant, wie synchronisiert.
  const events = [
    ev(1, 'Reise', '2026-09-24T04:00:00.000Z', '2026-09-25T22:00:00.000Z'), // 23.09. 18:00 bis 25.09. 12:00
    ev(2, 'Abend', '2026-09-25T05:00:00.000Z', '2026-09-25T06:00:00.000Z'), // 24.09. 19:00
  ];
  const program = dash.buildTodayProgram({ upcomingEvents: events }, { includeTasks: false, includeMeals: false, now: new Date() });
  assert.deepEqual(program.rows.map((row) => [row.title, row.sortKey]), [['Reise', '00:01'], ['Abend', '19:00']],
    'Platz im Tag nach der Wanduhr des Haushalts');
}));

// --------------------------------------------------------------------------
// 3. Die Familienkarte hat eigene Termine je Mitglied (#1449)
// --------------------------------------------------------------------------

const LEO = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Leo', 'hash', '#FF9500', 'member', 'child')
`).run(`today-leo-${randomUUID()}`).lastInsertRowid;
const assign = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
function addAssigned(title, start, end, userIds) {
  const id = addEvent(title, start, end);
  for (const uid of userIds) assign.run(id, uid);
  return id;
}
// 14:00 in Berlin. Leo hatte fuenf Termine am Morgen und hat einen am Abend;
// Anna hat fuenf am Nachmittag - genug, um den Deckel der Kachel zu fuellen.
const THU_14_BERLIN = '2026-09-24T12:00:00Z';
function seedBusyDay() {
  clearEvents();
  for (const h of ['06', '07', '08', '09', '10']) addAssigned(`Leo ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, [LEO]);
  addAssigned('Leo Abend', '2026-09-24T21:00', '2026-09-24T22:00', [LEO]);
  for (const h of ['15', '16', '17', '18', '19']) addAssigned(`Anna ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, [ADMIN]);
}

test('#1449: familyEvents traegt den Abendtermin, den der Deckel der Kachel abschneidet', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedBusyDay();
  const body = await getJson('/');
  assert.ok(!titles(body.upcomingEvents).includes('Leo Abend'), 'Vorbedingung: die Kachel zeigt fuenf Kommende, Leos Abend ist der sechste');
  const family = titles(body.familyEvents ?? []);
  assert.ok(family.includes('Leo Abend'), `familyEvents fehlt Leos Abendtermin: ${family.join(', ')}`);
  assert.ok(family.includes('Leo 10'), 'die heute beendeten kommen mit - sonst hiesse es „frei" statt „fuer heute durch"');
}));

test('#1449: „nur meine" der Kachel gilt nicht fuer die Familienkarte', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedBusyDay();
  const body = await getJson('/?events_scope=mine');
  assert.deepEqual([...new Set(titles(body.upcomingEvents).map((t) => t.split(' ')[0]))], ['Anna'], 'Vorbedingung: die Kachel zeigt nur Annas');
  assert.ok(titles(body.familyEvents ?? []).includes('Leo Abend'), 'die Karte zeigt jedes Mitglied - Leo ist nicht „frei"');
}));

test('#1449 Browser: die Karte liest familyEvents, nicht die Liste der Kachel', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const leo = { id: 7, display_name: 'Leo', avatar_color: '#FF9500' };
  const anna = { id: 8, display_name: 'Anna', avatar_color: '#7C3AED' };
  const mk = (id, title, start, end, who) => ev(id, title, start, end, { assigned_users: [{ id: who.id }] });
  const morning = ['06', '07', '08', '09', '10'].map((h, i) => mk(10 + i, `Leo ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, leo));
  const afternoon = ['15', '16', '17', '18', '19'].map((h, i) => mk(20 + i, `Anna ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, anna));
  const evening = mk(30, 'Leo Abend', '2026-09-24T21:00', '2026-09-24T22:00', leo);
  // Die Liste der Kachel: zwei beendete aus dem Pool, fuenf Kommende - ohne Leos Abend.
  const tile = [...morning, ...afternoon];
  const html = dash.renderFamilyWidget([anna, leo], {
    upcomingEvents: tile,
    familyEvents: [...morning, ...afternoon, evening],
  });
  const statusOf = (name) => (new RegExp(`family-member__name">${name}</span>\\s*<span class="family-member__status[^"]*">([^<]*)<`).exec(html) || [])[1];
  assert.equal(statusOf('Leo'), '2026-09-24T21:00 Leo Abend', `Leo hat heute noch den Abend, bekam ${statusOf('Leo')}`);
}));

test('#1449 Browser: endet ein Termin der Familienkarte, baut der Minutentakt neu', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  // Nur in familyEvents - die Kachel zeigt ihn nicht (Deckel oder „nur meine").
  const data = { upcomingEvents: [], familyEvents: [ev(30, 'Leo Abend', '2026-09-24T21:00', '2026-09-24T22:00', { assigned_users: [{ id: 7 }] })] };
  const before = dash.todayFingerprint(data, [], new Date('2026-09-24T19:59:00Z'));
  const after = dash.todayFingerprint(data, [], new Date('2026-09-24T20:01:00Z'));
  assert.notEqual(before, after, 'um 22:00 wechselt Leo auf „fuer heute durch" - ohne Neuladen');
}));

// --------------------------------------------------------------------------
// 4. „Heute bis HH:MM" ist die Uhrzeit des Haushalts (#1534)
// --------------------------------------------------------------------------
// Die Faelligkeit einer Aufgabe ist zonenlose Wanduhrzeit. Das Heute-Blatt
// baute daraus `new Date(`${due_date}T${due_time}`)` - einen Zeitpunkt der
// GERAETE-Zone - und reichte ihn an `formatTime`, das jeden Zeitpunkt in die
// Haushaltszone umrechnet. Liegt das Geraet woanders als der Haushalt, stand an
// einer Aufgabe fuer 18:00 eine andere Uhrzeit. Der Prozess laeuft deshalb in
// einer ANDEREN Zone als der Haushalt; der Stub von `formatTime` gibt sein
// Argument als Text zurueck, und gelesen wird es hier ueber `zonedTimeKey` -
// dieselbe Umrechnung (`zonedFields`), mit der das echte `formatTime` rechnet.

function inProcessZone(processZone, fn) {
  return async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = processZone;
    try {
      await fn();
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  };
}

const dueToday = (id, title, dueTime) => ({ id, title, due_date: '2026-09-24', due_time: dueTime, status: 'open', assigned_users: [] });
function todayUntil(row) {
  const m = /^dashboard\.todayUntil(\{.*\})$/.exec(row?.timeLabel ?? '');
  assert.ok(m, `Zeile ohne „heute bis": ${row?.timeLabel}`);
  return JSON.parse(m[1]).time;
}
function taskRows(now) {
  return dash.buildTodayProgram(
    { urgentTasks: [dueToday(1, 'Muell', '18:00'), dueToday(2, 'Spaet', '23:30:00'), dueToday(3, 'Frueh', '06:15')] },
    { includeCalendar: false, includeMeals: false, now },
  ).rows.filter((row) => row.kind === 'task');
}

test('#1534: „heute bis" nennt die Uhrzeit des Haushalts, nicht die des Geraets',
  inProcessZone('America/New_York', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    assert.equal(new Date('2026-09-24T12:00').getTimezoneOffset(), 240, 'Prozess muss in New York laufen');
    const rows = taskRows(new Date());
    assert.deepEqual(rows.map((row) => [row.title, tz.zonedTimeKey(todayUntil(row))]),
      [['Frueh', '06:15'], ['Muell', '18:00'], ['Spaet', '23:30']],
      'die eingetragene Wanduhrzeit, in Berlin wie eingetippt');
    assert.deepEqual(rows.map((row) => row.sortKey), ['06:15', '18:00', '23:30'], 'Platz im Tag nach derselben Uhr');
  })));

test('#1534: Geraet und Haushalt in derselben Zone - unveraendert',
  inProcessZone('Europe/Berlin', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    const rows = taskRows(new Date());
    assert.deepEqual(rows.map((row) => [row.title, tz.zonedTimeKey(todayUntil(row)), row.sortKey]),
      [['Frueh', '06:15', '06:15'], ['Muell', '18:00', '18:00'], ['Spaet', '23:30', '23:30']]);
  })));
