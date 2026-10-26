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
 *        5. Die Terminzeile nennt ihren Kalender statt „Termin" (#1698), im
 *           Heute-Blatt wie an der Wand; Beginn UND Ende zeigt nur die Wand,
 *           und nur mit echtem Ende unter einem Tag auf der Wanduhr.
 *
 * Ausfuehren: npm run test:dashboard-today
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
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

// `check_in` traegt mehrere Schreibweisen: `toISOString()` vom Check-in,
// '…SSZ' aus scripts/seed-demo.js und - von Hand eingespielt - zonenlose
// Wanduhrzeit. `ORDER BY check_in DESC LIMIT 1` sortierte sie als Text, und die
// Kachel nannte einen anderen "letzten Besuch" als die Modulseite.
function seedVisitFor(workerId, checkIn, checkOut) {
  db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by)
    VALUES (?, ?, 40, 0, ?, ?)
  `).run(checkIn, checkOut, workerId, ADMIN);
}

test('Haushaltshilfe: letzter Besuch und offene Sitzung sind der spaeteste Zeitpunkt, nicht der groesste Text',
  withClock('2031-07-15T12:00:00Z', 'Europe/Berlin', async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo'; // der Prozess bewusst in einer dritten Zone
    const otherUser = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role)
      VALUES (?, 'Jonas', 'hash', '#34C759', 'member')
    `).run(`today-helper-${randomUUID()}`).lastInsertRowid;
    const other = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)').run(otherUser).lastInsertRowid;
    try {
      clearVisits();
      // Abgeschlossen: 11:00 in Berlin (zonenlos) gegen 12:00 in Berlin (Instant) -
      // als Text ist '…T11' groesser als '…T10'.
      seedVisitFor(WORKER, '2031-07-15T11:00:00', '2031-07-15T11:30:00');
      seedVisitFor(WORKER, '2031-07-15T10:00:00.000Z', '2031-07-15T10:30:00.000Z');
      // Offen: Jonas seit 09:00 in Berlin (zonenlos), Maria seit 09:30 in Berlin (Instant).
      seedVisitFor(other, '2031-07-15T09:00:00', null);
      seedVisitFor(WORKER, '2031-07-15T07:30:00.000Z', null);
      const { housekeeping } = await getJson('/');
      assert.equal(housekeeping.lastVisit, '2031-07-15T10:00:00.000Z', 'der Besuch von 12:00, nicht der von 11:00');
      assert.equal(housekeeping.presentSince, '2031-07-15T07:30:00.000Z', 'die zuletzt begonnene offene Sitzung');
      assert.equal(housekeeping.workerName, 'Maria', 'und ihr Name');
      const module = (await getJson('/housekeeping/dashboard')).data;
      // Das Modul fragt nach dem letzten Besuch ueberhaupt, die Kachel nach dem
      // letzten ABGESCHLOSSENEN - ohne die offenen sagen beide denselben.
      db.prepare('DELETE FROM housekeeping_work_sessions WHERE check_out IS NULL').run();
      const moduleClosed = (await getJson('/housekeeping/dashboard')).data;
      assert.equal(module.last_visit.check_in, '2031-07-15T10:00:00.000Z', 'Vorbedingung: das Modul nennt denselben Besuch');
      assert.equal(moduleClosed.last_visit.check_in, housekeeping.lastVisit, 'Uebersicht und Modul sagen denselben letzten Besuch');

      // Dieselbe Sekunde in den zwei Schreibweisen echter Schreibwege: 'Z' sortiert hinter '.'.
      clearVisits();
      seedVisitFor(WORKER, '2031-07-15T09:00:00Z', '2031-07-15T09:10:00Z');
      seedVisitFor(WORKER, '2031-07-15T09:00:00.500Z', '2031-07-15T09:10:00.000Z');
      assert.equal((await getJson('/')).housekeeping.lastVisit, '2031-07-15T09:00:00.500Z', 'eine halbe Sekunde spaeter ist spaeter');
    } finally {
      clearVisits();
      db.prepare('DELETE FROM housekeeping_workers WHERE id = ?').run(other);
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
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
// Die Wand: jede zugewiesene Person, und das gewaehlte Icon (#1828, #1829)
// --------------------------------------------------------------------------
//
// Beide Fehler sassen im Browser, nicht im Server: die Antwort trug alle
// Zugewiesenen und das Icon schon. Deshalb laeuft hier die ECHTE Antwort der
// Route durch den Renderer der Wand - ein von Hand gebautes Objekt haette nur
// belegt, dass der Renderer liest, was der Test ihm hinlegt.

const { moduleIconHTML } = await import('/nav-icons.js');
const wallTask = (title, extra = {}) => ({ id: 1, title, due_date: '2026-09-24', due_time: '18:00', status: 'open', assigned_users: [], ...extra });

function onTheWall(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
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

const setIcon = db.prepare('UPDATE calendar_events SET icon = ? WHERE id = ?');

/** „Wer heute dran ist" als { Vorname: Zahl }. */
function wallCounts(html) {
  return Object.fromEntries(
    [...html.matchAll(/<li class="wall-who__member">[\s\S]*?<span aria-hidden="true">(\d+)<\/span>[\s\S]*?wall-who__name">([^<]*)<\/span>/g)]
      .map(([, count, name]) => [name, Number(count)]),
  );
}

/** Das Siegel jeder Programmzeile der Wand als { Titel: Markup }. */
function wallSeals(html) {
  return Object.fromEntries(
    [...html.matchAll(/<span class="module-seal wall-row__seal">([\s\S]*?)<\/span>\s*<span class="wall-row__body">\s*<span class="wall-row__title">([^<]*)<\/span>/g)]
      .map(([, seal, title]) => [title, seal.trim()]),
  );
}

test('#1828 Wand: ein Termin fuer zwei zaehlt bei BEIDEN, nicht nur bei der ersten Person',
  onTheWall(THU_14_BERLIN, 'Europe/Berlin', async () => {
    clearEvents();
    addAssigned('Elternabend', '2026-09-24T19:00', '2026-09-24T20:00', [ADMIN, LEO]);
    addAssigned('Training', '2026-09-24T17:00', '2026-09-24T18:00', [LEO]);
    const body = await getJson('/');
    const shared = body.upcomingEvents.find((event) => event.title === 'Elternabend');
    assert.deepEqual(shared.assigned_users.map((user) => user.display_name).sort(), ['Anna', 'Leo'],
      'Vorbedingung: die Antwort traegt beide Zugewiesenen');

    const html = dash.renderWallSurface(body, null, { now: new Date() });
    assert.deepEqual(wallCounts(html), { Leo: 2, Anna: 1 },
      'der gemeinsame Termin zaehlt bei Anna UND bei Leo; Leo hat dazu sein Training');
  }));

test('#1828 Wand: wer nur durch den gemeinsamen Termin dran ist, steht trotzdem in der Reihe',
  onTheWall(THU_14_BERLIN, 'Europe/Berlin', async () => {
    clearEvents();
    // Die Reihenfolge der Zuweisung darf nichts entscheiden: einmal Leo
    // zuerst, einmal Anna zuerst - beide Male stehen beide da.
    addAssigned('Zahnarzt', '2026-09-24T16:00', '2026-09-24T17:00', [LEO, ADMIN]);
    assert.deepEqual(wallCounts(dash.renderWallSurface(await getJson('/'), null, { now: new Date() })), { Anna: 1, Leo: 1 });
    clearEvents();
    addAssigned('Zahnarzt', '2026-09-24T16:00', '2026-09-24T17:00', [ADMIN, LEO]);
    assert.deepEqual(wallCounts(dash.renderWallSurface(await getJson('/'), null, { now: new Date() })), { Anna: 1, Leo: 1 });
  }));

test('#1829 Wand: der Termin zeigt sein gewaehltes Icon, das Kalenderzeichen nur ohne Wahl',
  onTheWall(THU_14_BERLIN, 'Europe/Berlin', async () => {
    clearEvents();
    setIcon.run('car', addEvent('Werkstatt', '2026-09-24T15:00', '2026-09-24T16:00'));
    setIcon.run('tooth', addEvent('Zahnarzt', '2026-09-24T16:00', '2026-09-24T17:00'));
    setIcon.run('drill', addEvent('Kontrolle', '2026-09-24T17:00', '2026-09-24T18:00'));
    setIcon.run('gibt-es-nicht', addEvent('Unbekannt', '2026-09-24T18:00', '2026-09-24T19:00'));
    const body = await getJson('/');
    const icons = Object.fromEntries(body.upcomingEvents.map((event) => [event.title, event.icon]));
    assert.deepEqual(icons, { Werkstatt: 'car', Zahnarzt: 'tooth', Kontrolle: 'drill', Unbekannt: 'gibt-es-nicht' },
      'Vorbedingung: die Antwort traegt das Icon jedes Termins');
    // Vier Zeilen: genau der Deckel der Wand. Der Termin ohne Wahl kommt danach allein.
    const seals = wallSeals(dash.renderWallSurface(body, null, { now: new Date() }));
    clearEvents();
    addEvent('Ohne Wahl', '2026-09-24T19:00', '2026-09-24T20:00');
    const plain = await getJson('/');
    assert.equal(plain.upcomingEvents[0].icon, 'calendar', 'Vorbedingung: ohne Wahl traegt die Spalte ihren Default');
    seals['Ohne Wahl'] = wallSeals(dash.renderWallSurface(plain, null, { now: new Date() }))['Ohne Wahl'];
    const generic = moduleIconHTML('calendar');

    assert.match(seals.Werkstatt, /data-lucide="car"/, 'ein Lucide-Icon steht als Platzhalter fuer createIcons da');
    assert.match(seals.Werkstatt, /class="module-glyph"/, 'mit der Marke, an der Groesse und Strichstaerke des Siegels haengen');
    assert.match(seals.Zahnarzt, /<svg class="module-glyph event-icon--custom"/, 'ein eigenes Zeichen (Zahn) wird gezeichnet wie im Kalender');
    assert.equal(seals.Kontrolle, seals.Zahnarzt, 'der alte Name `drill` ist derselbe Zahn - derselbe Alias wie im Kalender');
    assert.equal(seals['Ohne Wahl'], generic, 'ohne Wahl bleibt das Kalenderzeichen');
    assert.equal(seals.Unbekannt, generic, 'ein unbekannter Name faellt auf das Kalenderzeichen zurueck, statt ein leeres Siegel zu lassen');
    assert.notEqual(seals.Werkstatt, generic);
  }));

test('#1829 Wand: Aufgabe und Mahlzeit behalten ihr Modulzeichen', onTheWall(THU_14_BERLIN, 'Europe/Berlin', () => {
  // Eine Aufgabe, die zufaellig ein Feld `icon` truege, bekaeme kein Terminzeichen.
  const html = dash.renderWallSurface({ urgentTasks: [wallTask('Muell', { icon: 'car' })], users: [] }, null, { now: new Date() });
  assert.equal(wallSeals(html).Muell, moduleIconHTML('check-square'));
}));

/** Das Siegel jeder Zeile von „Heute wichtig" als { Titel: Markup }. */
function todaySeals(html) {
  return Object.fromEntries(
    [...html.matchAll(/<span class="module-seal today-cockpit-card__icon">([\s\S]*?)<\/span>(?:<span class="seal-pair__who[\s\S]*?)?<\/span>\s*<span class="today-cockpit-card__body">\s*<strong class="today-cockpit-card__value">([^<]*)<\/strong>/g)]
      .map(([, seal, title]) => [title, seal.trim()]),
  );
}

// „Heute wichtig" ist dieselbe Mischstelle wie die Wand und liest dieselben
// Zeilen: ein Termin, der dort sein Icon zeigt und hier das Kalenderzeichen,
// ist derselbe Fehler auf der zweiten Flaeche.
test('#1829 Heute wichtig: der Termin zeigt sein gewaehltes Icon wie an der Wand',
  onTheWall(THU_14_BERLIN, 'Europe/Berlin', async () => {
    clearEvents();
    setIcon.run('car', addEvent('Werkstatt', '2026-09-24T15:00', '2026-09-24T16:00'));
    setIcon.run('tooth', addEvent('Zahnarzt', '2026-09-24T16:00', '2026-09-24T17:00'));
    setIcon.run('drill', addEvent('Kontrolle', '2026-09-24T17:00', '2026-09-24T18:00'));
    setIcon.run('gibt-es-nicht', addEvent('Unbekannt', '2026-09-24T18:00', '2026-09-24T19:00'));
    addEvent('Ohne Wahl', '2026-09-24T19:00', '2026-09-24T20:00');
    const body = await getJson('/');
    const sheet = todaySeals(dash.renderTodayCockpit(body, [], false, { now: new Date() }));
    const wall = wallSeals(dash.renderWallSurface(body, null, { now: new Date() }));
    const generic = moduleIconHTML('calendar');

    assert.deepEqual(Object.keys(sheet).sort(), ['Kontrolle', 'Ohne Wahl', 'Unbekannt', 'Werkstatt', 'Zahnarzt'],
      'Vorbedingung: alle fuenf Termine stehen als Zeile im Blatt');
    assert.match(sheet.Werkstatt, /data-lucide="car"/, 'das gewaehlte Lucide-Icon steht im Siegel');
    assert.match(sheet.Werkstatt, /class="module-glyph"/, 'mit der Marke, an der Groesse und Strichstaerke des Siegels haengen');
    assert.match(sheet.Zahnarzt, /<svg class="module-glyph event-icon--custom"/, 'ein eigenes Zeichen (Zahn) wird gezeichnet wie im Kalender');
    assert.equal(sheet.Kontrolle, sheet.Zahnarzt, 'der alte Name `drill` ist derselbe Zahn');
    assert.equal(sheet['Ohne Wahl'], generic, 'ohne Wahl bleibt das Kalenderzeichen');
    assert.equal(sheet.Unbekannt, generic, 'ein unbekannter Name faellt auf das Kalenderzeichen zurueck');
    for (const title of ['Werkstatt', 'Zahnarzt', 'Kontrolle', 'Unbekannt']) {
      assert.equal(sheet[title], wall[title], `${title}: Blatt und Wand zeigen dasselbe Zeichen`);
    }
  }));

test('#1829 Heute wichtig: Aufgabe und Sammelzeile behalten das Modulzeichen',
  onTheWall(THU_14_BERLIN, 'Europe/Berlin', () => {
    // Eine Aufgabe, die zufaellig ein Feld `icon` truege, bekaeme kein Terminzeichen.
    const single = dash.renderTodayCockpit({ urgentTasks: [wallTask('Muell', { icon: 'car' })], users: [] }, [], false, { now: new Date() });
    assert.equal(todaySeals(single).Muell, moduleIconHTML('check-square'));
    // Die Sammelzeile der Ueberfaelligen spricht fuer mehrere Aufgaben, nicht fuer ein Objekt.
    const overdue = [1, 2, 3].map((id) => wallTask(`Alt ${id}`, { id, due_date: '2026-09-20', icon: 'car' }));
    global.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), media: query });
    const grouped = dash.renderTodayCockpit({ urgentTasks: overdue, users: [] }, [], false, { now: new Date(), overdueOpen: false });
    assert.match(grouped, /today-cockpit-card--overdue-group|data-today-overdue/, 'Vorbedingung: auf dem Telefon steht die Sammelzeile');
    assert.doesNotMatch(grouped, /data-lucide="car"/);
  }));

test('#1828 Wand: auch eine Aufgabe fuer zwei zaehlt bei beiden', onTheWall(THU_14_BERLIN, 'Europe/Berlin', () => {
  const anna = { id: 8, display_name: 'Anna', avatar_color: '#7C3AED' };
  const leo = { id: 7, display_name: 'Leo', avatar_color: '#FF9500' };
  // Seit #1817 zaehlt die Wand die Aufgaben einer Person aus `wallTasks`, nicht
  // mehr aus den (gekappten) Programmzeilen: der Server liefert je zugewiesener
  // Person einen Eintrag (test:wall-tasks, "mehrere Zugewiesene"). Die
  // Programmzeile daneben darf die Aufgabe bei keinem der beiden ein zweites
  // Mal zaehlen.
  const task = wallTask('Zimmer aufraeumen', { assigned_users: [leo, anna] });
  const entry = (user) => ({
    user_id: user.id, open_count: 1, done_count: 0,
    open: [{ id: task.id, title: task.title, due_date: task.due_date }], done: [],
  });
  const html = dash.renderWallSurface({
    urgentTasks: [task],
    wallTasks: [entry(leo), entry(anna)],
    users: [anna, leo],
  }, null, { now: new Date() });
  assert.deepEqual(wallCounts(html), { Anna: 1, Leo: 1 });
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

// --------------------------------------------------------------------------
// 5. Die Wand nennt Kalender und Spanne eines Termins (#1698, D#988)
// --------------------------------------------------------------------------

function wallRowTime(row) {
  const m = /<span class="wall-row__time[^"]*">([^<]*)(?:<span class="wall-row__time-end">([^<]*)<\/span>)?<\/span>/.exec(row);
  return m ? `${m[1]}${m[2] ?? ''}` : null;
}

function wallRows(events, { tasks = [], tone = 'event' } = {}) {
  const html = dash.renderWallSurface({ upcomingEvents: events, urgentTasks: tasks, users: [] }, null, { now: new Date() });
  return [...html.matchAll(new RegExp(`<li class="wall-row wall-row--${tone}">([\\s\\S]*?)</li>`, 'g'))].map(([, row]) => ({
    title: (/wall-row__title">([^<]*)</.exec(row) || [])[1],
    sub: (/wall-row__sub">([^<]*)</.exec(row) || [])[1],
    // Die ganze Zeitangabe, wie sie zu lesen ist: der Beginn und, in einem
    // eigenen Element dahinter, das Ende.
    time: wallRowTime(row),
  }));
}

test('#1698 Wand: der Kalendername ersetzt „Termin", und die Zeit nennt Beginn und Ende', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const rows = wallRows([
    ev(1, 'Frueh', '2026-09-24T14:00', '2026-09-24T22:00', { cal_name: 'Niklas Arbeitskalender' }),
  ]);
  assert.deepEqual(rows, [{ title: 'Frueh', sub: 'Niklas Arbeitskalender', time: '2026-09-24T14:00 - 2026-09-24T22:00' }]);
}));

test('#1698 Wand: ohne Kalendernamen bleibt das Wort, und der Name laeuft durch esc()', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const rows = wallRows([
    ev(1, 'Nur in Yuvomi', '2026-09-24T14:00', '2026-09-24T15:00'),
    ev(2, 'Leer', '2026-09-24T15:00', '2026-09-24T16:00', { cal_name: '   ' }),
    ev(3, 'Boese', '2026-09-24T16:00', '2026-09-24T17:00', { cal_name: '<img src=x>' }),
  ]);
  assert.deepEqual(rows.map((row) => row.sub), ['dashboard.todayEvent', 'dashboard.todayEvent', '&lt;img src=x&gt;']);
}));

test('#1698 Wand: eine Spanne nur mit echtem Ende am selben Tag oder in der Nacht', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  // Zwei Aufrufe: die Wand zeigt hoechstens WALL_ROW_CAP Zeilen.
  const by = Object.fromEntries([
    ...wallRows([
      ev(1, 'Ohne Ende', '2026-09-24T14:00', null),
      ev(2, 'Ende gleich Beginn', '2026-09-24T15:00', '2026-09-24T15:00'),
      ev(3, 'Nachtschicht', '2026-09-24T22:00', '2026-09-25T06:00'),
    ]),
    ...wallRows([
      ev(4, 'Reise ab heute', '2026-09-24T18:00', '2026-09-26T12:00'),
      ev(5, 'Ganztags', '2026-09-24', '2026-09-24', { all_day: 1 }),
      ev(6, 'Seit gestern', '2026-09-23T20:00', '2026-09-24T12:00'),
    ]),
  ].map((row) => [row.title, row.time]));
  assert.deepEqual(by, {
    'Ohne Ende': '2026-09-24T14:00',
    'Ende gleich Beginn': '2026-09-24T15:00',
    Nachtschicht: '2026-09-24T22:00 - 2026-09-25T06:00',
    'Reise ab heute': '2026-09-24T18:00',
    Ganztags: 'dashboard.allDay',
    'Seit gestern': 'dashboard.todayUntil{&quot;time&quot;:&quot;2026-09-24T12:00&quot;}',
  });
}));

test('#1698 Wand: das Ende steht in einem eigenen Element - die schmale Flaeche blendet es aus', inBrowser(THU_10_BERLIN, 'Europe/Berlin', async () => {
  const html = dash.renderWallSurface({
    upcomingEvents: [ev(1, 'Frueh', '2026-09-24T14:00', '2026-09-24T22:00')], urgentTasks: [], users: [],
  }, null, { now: new Date() });
  assert.match(html, /wall-row__time">2026-09-24T14:00<span class="wall-row__time-end"> - 2026-09-24T22:00<\/span><\/span>/);
  // Und die Regel dazu steht im Stylesheet, an der Grenze des Titels.
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /@container wall \(max-width: 519px\) \{\s*\.wall-row__time-end \{\s*display: none;/);
}));

test('#1698: das Heute-Blatt nennt den Kalender - die Spanne bleibt der Wand', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const events = [
    ev(1, 'Frueh', '2026-09-24T14:00', '2026-09-24T22:00', { cal_name: 'Niklas Arbeitskalender' }),
    ev(2, 'Nur in Yuvomi', '2026-09-24T15:00', '2026-09-24T16:00'),
    ev(3, 'Boese', '2026-09-24T16:00', '2026-09-24T17:00', { cal_name: '<img src=x>' }),
  ];
  const rows = dash.buildTodayProgram({ upcomingEvents: events }, { includeTasks: false, includeMeals: false, now: new Date() }).rows;
  assert.deepEqual(rows.map((row) => [row.title, row.sub, row.timeLabel]), [
    ['Frueh', 'Niklas Arbeitskalender', '2026-09-24T14:00'],
    ['Nur in Yuvomi', 'dashboard.todayEvent', '2026-09-24T15:00'],
    ['Boese', '<img src=x>', '2026-09-24T16:00'],
  ]);
  const sheet = dash.renderTodayCockpit({ upcomingEvents: events, urgentTasks: [], users: [] }, []);
  assert.match(sheet, /today-cockpit-card__sub">Niklas Arbeitskalender</, 'das Blatt nennt den Kalender');
  assert.match(sheet, /today-cockpit-card__sub">dashboard\.todayEvent</, 'ohne Kalendernamen bleibt das Wort');
  assert.ok(sheet.includes('&lt;img src=x&gt;') && !sheet.includes('<img src=x>'), 'der Name ist Nutzereingabe und laeuft durch esc()');
  assert.ok(!sheet.includes('2026-09-24T22:00'), 'kein Ende im Blatt: die Spanne bleibt der Wand vorbehalten');
  assert.ok(!sheet.includes('wall-row__time-end'));
}));

test('#1698: die Unterzeile des Blatts bleibt eine Zeile, die Zustandskarte darf umbrechen', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)].filter((rule) => rule.at.length === 0);
  const own = rules.find((rule) => rule.selector.trim() === '.today-cockpit-card__sub');
  assert.ok(own, 'Reichweite: die Regel der Unterzeile');
  assert.match(own.body, /white-space:\s*nowrap/);
  assert.match(own.body, /text-overflow:\s*ellipsis/);
  const state = rules.find((rule) => rule.selector.trim() === '.today-cockpit-card--state .today-cockpit-card__sub');
  assert.match(state?.body ?? '', /white-space:\s*normal/);
});

test('#1698: der Kalendername ist der des gewaehlten Ziels - `source_calendar_name` vor `cal_name`', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  // Wie im Kalendermodul: ein neu angelegter Termin wartet noch auf seinen
  // Upload (`cal_name` fehlt), ein umziehender nennt in `cal_name` noch den
  // alten Kalender.
  const events = [
    ev(1, 'Wartet auf Upload', '2026-09-24T14:00', '2026-09-24T15:00', { source_calendar_name: 'Arbeit' }),
    ev(2, 'Zieht um', '2026-09-24T15:00', '2026-09-24T16:00', { cal_name: 'Alt', source_calendar_name: 'Neu' }),
    ev(3, 'Nur verknuepft', '2026-09-24T16:00', '2026-09-24T17:00', { cal_name: 'Familie', source_calendar_name: '  ' }),
  ];
  const rows = dash.buildTodayProgram({ upcomingEvents: events }, { includeTasks: false, includeMeals: false, now: new Date() }).rows;
  assert.deepEqual(rows.map((row) => row.sub), ['Arbeit', 'Neu', 'Familie']);
  assert.deepEqual(wallRows(events).map((row) => row.sub), ['Arbeit', 'Neu', 'Familie']);
}));

// --- Nachzug aus dem Review von #1826 ---

// Samstag, 27.03.2027, 10:00 in Berlin - in der Nacht darauf springt die Uhr
// von 02:00 auf 03:00, der Tag bis Sonntag 22:00 hat 23 Stunden.
const SAT_BEFORE_DST = '2027-03-27T09:00:00Z';
const dstNight = () => Object.fromEntries(wallRows([
  ev(1, 'Genau ein Tag', '2027-03-27T22:00', '2027-03-28T22:00'),
  ev(2, 'Ein Tag und mehr', '2027-03-27T22:00', '2027-03-28T22:30'),
  ev(3, 'Die Nacht', '2027-03-27T22:00', '2027-03-28T06:00'),
]).map((row) => [row.title, row.time]));
const DST_EXPECTED = {
  'Genau ein Tag': '2027-03-27T22:00',
  'Ein Tag und mehr': '2027-03-27T22:00',
  'Die Nacht': '2027-03-27T22:00 - 2027-03-28T06:00',
};

// Die Geraetezone ist ausdruecklich gesetzt, nicht geerbt: mit Berlin als
// Geraet war die Millisekunden-Rechnung in dieser Nacht falsch, mit einem
// Geraet ohne Sommerzeit zufaellig richtig - beide muessen dasselbe sagen.
for (const device of ['Europe/Berlin', 'UTC', 'America/New_York']) {
  test(`#1698 Wand: „ein Tag oder mehr" misst die Wanduhr des Haushalts, auch in der Umstellungsnacht (Geraet ${device})`,
    inProcessZone(device, inBrowser(SAT_BEFORE_DST, 'Europe/Berlin', () => {
      assert.deepEqual(dstNight(), DST_EXPECTED);
    })));
}

test('#1698 Wand: genau 24 Stunden sind ein Tag - eine Minute weniger ist eine Spanne',
  inProcessZone('UTC', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    const by = Object.fromEntries(wallRows([
      ev(1, 'Bis morgen selbe Zeit', '2026-09-24T14:00', '2026-09-25T14:00'),
      ev(2, 'Eine Minute weniger', '2026-09-24T14:00', '2026-09-25T13:59'),
      ev(3, 'Morgen spaeter', '2026-09-24T14:00', '2026-09-25T19:00'),
    ]).map((row) => [row.title, row.time]));
    assert.deepEqual(by, {
      'Bis morgen selbe Zeit': '2026-09-24T14:00',
      'Eine Minute weniger': '2026-09-24T14:00 - 2026-09-25T13:59',
      'Morgen spaeter': '2026-09-24T14:00',
    });
  })));

test('#1698 Wand: eine Zeile ohne Wand-Fassung behaelt Untertitel und Zeit', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  // Nur der Termin traegt `wallTimeEnd`. Aufgabe, Mahlzeit, Dosis und Abfall
  // zeigen in `renderWallRow` ihr `sub` und ihr `timeLabel` allein.
  const rows = wallRows([], { tasks: [dueToday(1, 'Muell', '18:00')], tone: 'task' });
  assert.equal(rows.length, 1, 'Reichweite: die Aufgabenzeile steht an der Wand');
  assert.equal(rows[0].title, 'Muell');
  assert.equal(rows[0].sub, 'dashboard.todayTask');
  assert.match(String(rows[0].time), /^dashboard\.todayUntil\{/);
}));

test('#1698 Wand: ganztaegig bleibt ganztaegig, auch mit Uhrzeit im Wert; ein Ende ohne Uhrzeit ist kein Ende',
  inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    const by = Object.fromEntries(wallRows([
      ev(1, 'Ganztags mit Uhrzeit', '2026-09-24T00:00', '2026-09-24T23:59', { all_day: 1 }),
      ev(2, 'Ende nur als Datum', '2026-09-24T15:00', '2026-09-24'),
      // Ein Datum am FOLGETAG liest als Stempel Mitternacht - „15:30 - 00:00"
      // waere eine Uhrzeit, die niemand eingetragen hat.
      ev(3, 'Ende als Datum von morgen', '2026-09-24T15:30', '2026-09-25'),
    ]).map((row) => [row.title, row.time]));
    assert.deepEqual(by, {
      'Ganztags mit Uhrzeit': 'dashboard.allDay',
      'Ende nur als Datum': '2026-09-24T15:00',
      'Ende als Datum von morgen': '2026-09-24T15:30',
    });
  }));

test('#1698 Wand: Beginn UND Ende gehen durch den echten Formatierer (12-Stunden-Format)',
  inProcessZone('America/New_York', inBrowser(THU_10_BERLIN, 'Europe/Berlin', async () => {
    const { formatTime: realFormatTime } = await import('../public/i18n.js');
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: { getItem: (key) => (key === 'yuvomi-time-format' ? '12h' : null), setItem() {}, removeItem() {} },
    });
    globalThis.__formatTime = realFormatTime;
    try {
      assert.equal(realFormatTime('2026-09-24T14:00'), '2:00 PM', 'Vorbedingung: der Formatierer schreibt 12-stuendig');
      const rows = wallRows([ev(1, 'Frueh', '2026-09-24T14:00', '2026-09-24T22:00', { cal_name: 'Arbeit' })]);
      assert.deepEqual(rows, [{ title: 'Frueh', sub: 'Arbeit', time: '2:00 PM - 10:00 PM' }]);
    } finally {
      delete globalThis.__formatTime;
      if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
      else delete globalThis.localStorage;
    }
  })));

// --------------------------------------------------------------------------
// 6. Kinder-Standards (R20): eigene Aufgaben zuerst, Punkte vor Budget
// --------------------------------------------------------------------------

const KIND = { id: 3, family_role: 'child', display_name: 'Emma' };
const MAMA = { id: 1, family_role: 'mom', display_name: 'Linda' };
const assigned = (task, ...people) => ({ ...task, assigned_users: people.map((p) => ({ id: p.id, display_name: p.display_name })) });
const childTasks = () => [
  assigned({ id: 11, title: 'Steuer', due_date: '2026-09-23', status: 'open' }, MAMA),
  assigned({ id: 12, title: 'Arzt anrufen', due_date: '2026-09-23', status: 'open' }, MAMA),
  assigned({ id: 13, title: 'Zimmer aufraeumen', due_date: '2026-09-24', due_time: '17:00', status: 'open' }, KIND),
  { id: 14, title: 'Blumen giessen', due_date: '2026-09-24', status: 'open', assigned_users: [] },
  assigned({ id: 15, title: 'Hausaufgaben', due_date: '2026-09-23', status: 'open' }, KIND),
];

test('R20: ein Kind sieht im Heute-Blatt eigene und freie Aufgaben vor denen der Eltern',
  inProcessZone('Europe/Berlin', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    const titles = (viewer) => dash.buildTodayProgram({ urgentTasks: childTasks() }, {
      includeCalendar: false, includeMeals: false, now: new Date(), viewer,
    }).rows.map((row) => row.title);
    assert.deepEqual(titles(KIND), ['Hausaufgaben', 'Blumen giessen', 'Zimmer aufraeumen', 'Steuer', 'Arzt anrufen'],
      'eigene (auch ueberfaellige) und freie zuerst, die der Mutter am Ende');
    assert.deepEqual(titles(MAMA), ['Steuer', 'Arzt anrufen', 'Hausaufgaben', 'Blumen giessen', 'Zimmer aufraeumen'],
      'Erwachsene: unveraendert nach der Uhr');
    assert.deepEqual(titles(null), titles(MAMA), 'ohne Betrachter wie bisher');
  })));

test('R20: bei knappem Platz fallen die fremden Aufgaben eines Kindes zuerst unter „+N weitere"',
  inProcessZone('Europe/Berlin', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
    const model = dash.buildTodayCockpitModel({ urgentTasks: childTasks() }, [], {
      cap: 3, now: new Date(), groupOverdue: true, viewer: KIND,
    });
    const shown = model.rows.map((row) => row.title);
    assert.deepEqual(shown, ['Hausaufgaben', 'Blumen giessen', 'Zimmer aufraeumen'], 'die Aufgaben der Mutter stehen nicht im sichtbaren Blatt');
    assert.equal(model.overflow, 2);
    assert.deepEqual(model.hiddenRows.map((row) => row.title).sort(), ['Arzt anrufen', 'Steuer']);
  })));

test('R20: die Kinder-Vorgabe der Kacheln - Punkte zuerst und sichtbar, Budget aus, nur bei gefolgter Vorgabe', async () => {
  const { childDefaultWidgetConfig, DEFAULT_WIDGET_CONFIG } = await import('../public/utils/dashboard-widgets.js');
  // Ein Haushalt, der das Budget eingeblendet hat (seit R21 ist es ab Werk aus).
  const household = DEFAULT_WIDGET_CONFIG.map((w) => (w.id === 'budget' ? { ...w, visible: true } : w));
  const kid = childDefaultWidgetConfig(household);
  assert.equal(kid[0].id, 'rewards');
  assert.equal(kid[0].visible, true);
  assert.equal(kid.find((w) => w.id === 'budget').visible, false);
  assert.deepEqual(kid.map((w) => w.order), kid.map((_, i) => i));
  assert.equal(kid.length, DEFAULT_WIDGET_CONFIG.length, 'keine Kachel verschwindet aus dem Anpassen-Tray');
  assert.equal(household.find((w) => w.id === 'budget').visible, true, 'die Eingabe bleibt unberuehrt');

  assert.deepEqual(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, KIND, true), kid);
  assert.equal(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, KIND, false), DEFAULT_WIDGET_CONFIG, 'ein eigenes Layout bleibt');
  assert.equal(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, MAMA, true), DEFAULT_WIDGET_CONFIG, 'Erwachsene bekommen die Haushaltsvorgabe');
});

test('R20: die Seite setzt den Betrachter, den das Heute-Blatt fragt', () => {
  // Die Optionen oben reichen den Betrachter selbst herein; diese Zeile haelt
  // fest, dass der echte Aufrufer (render -> buildTodayCockpitModel ohne
  // `viewer`) ihn auch bekommt.
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /export async function render\([\s\S]{0,1500}?dashboardViewer = user \?\? null;/);
  assert.match(src, /viewer = dashboardViewer,\n\} = \{\}\) \{/, 'buildTodayCockpitModel faellt auf den gesetzten Betrachter zurueck');
  assert.match(src, /buildTodayProgram\(data, \{ includeTasks, includeCalendar, includeMeals, now, viewer \}\)/);
});

// „ALS NAECHSTES" (Entwurf „Heute wichtig", 2026-10-26; loest R22 D16 ab):
// breit stehen die Zeilen nicht mehr in zwei Spalten, sondern als drei Zellen
// nebeneinander - die letzte ist der Einkauf -, und „+N weitere" steht in der
// Fussleiste hinter den Zellen. Der Einkauf steht weiter VOR dem Aufklapper.
test('Entwurf „Heute wichtig": breit drei Zellen, der Einkauf zuletzt, „+N weitere" in der Fussleiste', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  // Aufgaben mit Uhrzeit: Termine stehen auf der breiten Buehne in der Zeitleiste, nicht in der Liste.
  const tasks = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, due_date: '2026-09-24',
    due_time: `${String(11 + i).padStart(2, '0')}:00`, status: 'open', assigned_users: [] }));
  const sheet = dash.renderTodayCockpit({ urgentTasks: tasks, users: [], shoppingOpenCount: 3 }, [], false, { now: new Date(), moreOpen: false });
  const strip = /<div class="today-cockpit__rows today-cockpit__rows--next" style="--today-next-cols:(\d)">([\s\S]*?)<\/div>\s*<div class="today-cockpit__foot">/.exec(sheet);
  assert.ok(strip, 'Vorbedingung: die Leiste „Als Naechstes" steht im Blatt, die Fussleiste folgt ihr');
  assert.equal(strip[1], '3', 'drei Spalten');
  const cells = [...strip[2].matchAll(/class="today-cockpit-card today-cockpit-card--(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(cells, ['task', 'task', 'shopping'], 'zwei Zeilen, der Einkauf als dritte Zelle');
  assert.match(strip[2], /today-cockpit-card__chevron/, 'der Einkauf zeigt seinen Weg statt einer Zeit');
  // Nur Aufgaben verdeckt: „+N weitere" fuehrt in die Aufgabenliste (todayMoreRoute).
  assert.match(sheet, /<div class="today-cockpit__foot">\s*<a href="\/tasks\?due=today" class="today-cockpit__more/, '„+N weitere" steht in der Fussleiste');
  assert.match(sheet, /dashboard\.todayMore\{(?:"|&quot;)count(?:"|&quot;):7\}/, 'und zaehlt, was nicht in die Zellen passt');
  assert.ok(sheet.indexOf('today-cockpit-card--shopping') < sheet.indexOf('class="today-cockpit__more'), 'der Einkauf steht vor dem Weg zu den uebrigen (R22 D16)');

  const two = dash.renderTodayCockpit({ urgentTasks: tasks.slice(0, 2), users: [] }, [], false, { now: new Date() });
  assert.match(two, /today-cockpit__rows--next" style="--today-next-cols:2"/, 'zwei Zeilen fuellen zwei Spalten, keine leere dritte');
}));

test('Entwurf „Heute wichtig": die Zellen trennt eine senkrechte Haarlinie, die Leiste eine waagerechte', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8'))].filter((r) => !r.at.length);
  const body = (sel) => rules.find((r) => r.selector.trim() === sel)?.body ?? '';
  assert.match(body('.today-cockpit__rows.today-cockpit__rows--next'), /grid-template-columns:\s*repeat\(var\(--today-next-cols, 3\), minmax\(0, 1fr\)\)/);
  assert.match(body('.today-cockpit__rows.today-cockpit__rows--next'), /border-top:\s*1px solid var\(--color-border-subtle\)/);
  const cell = body('.today-cockpit__rows--next > .today-cockpit-card + .today-cockpit-card');
  assert.match(cell, /border-top:\s*none/, 'keine waagerechte Linie zwischen den Zellen einer Reihe');
  assert.match(cell, /border-inline-start:\s*1px solid var\(--color-border-subtle\)/, 'eine senkrechte zwischen ihnen');
  assert.ok(!rules.some((r) => /today-cockpit__rows--split/.test(r.selector)), 'die zweispaltige Liste ist abgeloest');
});

// R23 (Critique G1 P2): die Titel des Blatts standen je Zeile 12px versetzt -
// die erste Spalte war `auto`, und ein Siegel mit Avatar ist breiter als eines
// allein. Mobil stand die erste Zeile bei y 226: Werkzeuge ueber dem Datum,
// die Wetterzeile in einer eigenen Zeile, „Heute wichtig" darueber.
test('R23: eine Titelkante im Blatt, mobil Wetter neben den Werkzeugen; die Blatt-Ueberschrift steht in der Karte', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const all = [...eachRule(readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8'))];
  const rules = all.filter((r) => !r.at.length);
  const card = rules.filter((r) => r.selector.trim() === '.today-cockpit-card' && /grid-template-columns/.test(r.body)).at(-1);
  const columns = /grid-template-columns:\s*([^;]+)/.exec(card?.body ?? '')?.[1] ?? '';
  assert.ok(columns && !/^auto\b/.test(columns.trim()), `die Siegelspalte ist fest, nicht auto (${columns})`);
  assert.match(columns, /var\(--target-sm\)\s*\+\s*var\(--space-5\)\s*-\s*var\(--space-2\)/, 'so breit wie das Paar aus Siegel und Avatar (.seal-pair)');
  const header = rules.filter((r) => r.selector.trim() === '.dashboard-overview__header' && /grid-template-areas/.test(r.body)).at(0);
  assert.match(header?.body ?? '', /"date\s+tools"\s*"weather\s+tools"\s*"title\s+title"/, 'mobil: Datum und Wetter in der Hoehe der Knoepfe, der Gruss darunter');
  // Seit dem Entwurf „Heute wichtig" (2026-10-26) steht die Ueberschrift auch
  // mobil in der Karte - kompakt, mit der Summe rechts. Keine Regel blendet sie aus.
  assert.ok(!all.some((r) => /today-cockpit__header/.test(r.selector) && /clip:\s*rect/.test(r.body)), 'die Ueberschrift ist sichtbar');
  const phoneHeader = all.find((r) => r.selector.trim() === '.today-cockpit__grid > .today-cockpit__header' && r.at.some((a) => /max-width:\s*639px/.test(a)));
  assert.ok(phoneHeader, 'mobil hat der Kopf seine kompakte Fassung');
});

// R23 (Critique G1 P3): dieselbe Regel fuer die Eltern-Sicht - neben hohen
// Nachbarn stand „2 zu bestaetigen" 230px unter den Punktestaenden (1440).
test('R22 D16 + R23: die Anfrage folgt den Punkten - im Kindkonto wie in der Eltern-Sicht', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8'))].filter((r) => !r.at.length);
  const footer = rules.filter((r) => r.selector.split(',').some((s) => /\.rewards-widget\b[^,]*\.rewards-widget__footer/.test(s)));
  const last = footer.filter((r) => /margin-block-start/.test(r.body)).at(-1);
  assert.ok(last, 'Vorbedingung: eine Regel setzt den Abstand des Fusses');
  assert.match(last.selector, /^\s*\.dashboard \.rewards-widget > \.rewards-widget__footer\s*$/, 'die Regel gilt jeder Belohnungskachel, nicht nur der eigenen');
  assert.match(last.body, /margin-block-start:\s*0/, 'kein margin-block-start: auto unter Punkten und Balken');
});

// DIE ZEITLEISTE DES HEUTE-BLATTS (Entwurf „Heute wichtig", 2026-10-26).
// Gegen die echte Darstellung: Spuren je Person aus BEIDEN Terminlisten,
// Vergangenes zurueckgetreten statt verschwunden, ganztaegig nur in der Summe,
// und die Leiste schweigt, wo sie Echo waere (sichtbare Termin-Kachel) oder
// keinen Platz hat (Telefon). Das reine Layout prueft test:today-timeline.
const TIMELINE_USERS = [
  { id: 1, display_name: 'Alex Johnson', avatar_color: '#0A84FF' },
  { id: 2, display_name: 'Linda Johnson', avatar_color: '#FF2D55' },
  { id: 3, display_name: 'Emma Johnson', avatar_color: '#BF5AF2' },
  { id: 4, display_name: 'Leo Johnson', avatar_color: '#FF9500' },
];
const person = (id) => ({ id, display_name: TIMELINE_USERS.find((u) => u.id === id).display_name, color: '#0A84FF' });
const timelineDay = () => ({
  upcomingEvents: [
    ev(11, 'Zahnarzt', '2026-09-24T08:30', '2026-09-24T09:30', { assigned_users: [person(1)] }),
    ev(12, 'Schule', '2026-09-24T08:00', '2026-09-24T13:00', { assigned_users: [person(3)] }),
    ev(13, 'Ausflug', '2026-09-24', '2026-09-24', { all_day: 1 }),
    ev(14, 'Filmabend', '2026-09-24T20:15', '2026-09-24T22:00'),
  ],
  // Die Familienliste traegt die Schule noch einmal und den Fussball, den der
  // Deckel der Kachel abgeschnitten haette.
  familyEvents: [
    ev(12, 'Schule', '2026-09-24T08:00', '2026-09-24T13:00', { assigned_users: [person(3)] }),
    ev(15, 'Fussball', '2026-09-24T16:00', '2026-09-24T17:30', { assigned_users: [person(4)] }),
  ],
  urgentTasks: [{ id: 21, title: 'Stromrechnung', due_date: '2026-09-22', status: 'open', assigned_users: [] }],
  users: TIMELINE_USERS,
});
const { sharedSurname: realSharedSurname } = await import("../public/components/user-multi-select.js");
const timelineOf = (html) => (/<div class="today-timeline[\s\S]*?<\/div>\s*<div class="today-cockpit__rows/.exec(html) || [''])[0];

test('Heute-Blatt: die Zeitleiste zeigt den ganzen Tag je Person, die Summe nennt ihn in einem Satz', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const before = globalThis.__sharedSurname;
  globalThis.__sharedSurname = realSharedSurname;
  let sheet;
  try { sheet = dash.renderTodayCockpit(timelineDay(), []); } finally { globalThis.__sharedSurname = before; }
  const timeline = timelineOf(sheet);
  assert.ok(timeline, 'auf der breiten Buehne steht die Leiste ueber den Zeilen');
  // „Alle" zuerst, dann die Mitglieder in Haushaltsreihenfolge; Linda hat heute nichts.
  assert.deepEqual([...timeline.matchAll(/today-timeline__name">([^<]*)</g)].map((m) => m[1]), ['dashboard.todayTimelineEveryone', 'Alex', 'Emma', 'Leo']);
  assert.match(timeline, /aria-label="Alex Johnson"/, 'der volle Name bleibt der zugaengliche Name der Spur');
  // Beide Listen, ein Termin: die Schule einmal, der Fussball aus der Familienliste.
  assert.equal(timeline.match(/today-timeline__title">Schule</g)?.length, 1);
  assert.match(timeline, /today-timeline__title">Fussball</);
  // Vorbei tritt zurueck und sagt es, laufend sagt es auch; Ganztaegiges hat keinen Block.
  assert.match(timeline, /today-timeline__event--past"[^>]*>\s*<span class="today-timeline__title">Zahnarzt<[\s\S]*?dashboard\.todayTimelinePast/);
  assert.match(timeline, /today-timeline__event--now"[^>]*>\s*<span class="today-timeline__title">Schule</);
  assert.ok(!timeline.includes('Ausflug'));
  // Nur der Beginn (#1698), das Ende traegt die Breite.
  assert.ok(!timeline.includes('2026-09-24T13:00'));
  // 10:00 auf der Achse 07-22.
  assert.match(timeline, /--tl-now:0\.2(?![\d])|--tl-now:0\.19999/);
  assert.match(sheet, /today-cockpit__summary">dashboard\.todaySummaryEvents\{&quot;count&quot;:5\} · dashboard\.todaySummaryOverdue\{&quot;count&quot;:1\}</,
    'fuenf Termine samt ganztaegigem, eine ueberfaellige Aufgabe');
}));

test('Heute-Blatt: keine Zeitleiste neben der Termin-Kachel, auf dem Telefon nur die Kurzfassung', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const withTile = dash.renderTodayCockpit(timelineDay(), [{ id: 'calendar', visible: true }]);
  assert.ok(!withTile.includes('today-timeline'), 'die Leiste waere das Echo der Kachel');
  assert.ok(!withTile.includes('todaySummaryEvents'), 'und die Termine zaehlt die Kachel');
  assert.match(withTile, /todaySummaryOverdue/, 'das Ueberfaellige spricht weiter, solange die Aufgaben im Blatt sprechen');
  global.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), media: query });
  const phone = dash.renderTodayCockpit(timelineDay(), []);
  // Mobil die Kurzfassung des Entwurfs: Bild, ohne Knoepfe und ohne Text in
  // den Balken - die Termine bleiben Zeilen.
  assert.match(phone, /<div class="today-timeline today-timeline--mini" aria-hidden="true"/);
  assert.ok(!phone.includes('data-timeline-event'), 'kein Tippziel in einem 10px-Balken');
  assert.match(phone, /today-cockpit-card__value">Filmabend</, 'der Termin steht als Zeile');
}));

test('Heute-Blatt: ein Termin der Zeitleiste steht nicht noch einmal in der Liste - sein Block klappt die Zeile auf', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const day = timelineDay();
  day.upcomingEvents.push(ev(16, 'Elternabend', '2026-09-24T19:00', '2026-09-24T20:30', { assigned_users: [person(1), person(2)] }));
  const sheet = dash.renderTodayCockpit(day, []);
  const list = sheet.slice(sheet.indexOf('class="today-cockpit__rows'));
  // In der Liste: das Ganztaegige (kein Block), die Aufgabe - kein Termin mit Uhrzeit.
  assert.match(list, /today-cockpit-card__value">Ausflug</);
  for (const title of ['Schule', 'Filmabend', 'Fussball', 'Elternabend']) {
    assert.ok(!list.includes(`today-cockpit-card__value">${title}<`), `${title} steht nur in der Leiste`);
  }
  // Der Block ist ein Aufklapp-Knopf auf die Zeile darunter, zugeklappt bis zum Klick.
  assert.match(sheet, /<button type="button" class="today-timeline__event today-timeline__event--next" data-timeline-event="14@2026-09-24T20:15"\s+aria-expanded="false" aria-controls="today-timeline-detail">/);
  assert.match(sheet, /id="today-timeline-detail" hidden>/);
  // Je Termin eine Zeile, auch wenn er in zwei Spuren steht; sie traegt die Zuweisung.
  assert.equal(sheet.match(/data-timeline-detail="16@2026-09-24T19:00"/g)?.length, 1);
  assert.match(sheet, /today-cockpit-card__sub">dashboard\.todayEvent · Alex Johnson, Linda Johnson</);
  const detail16 = /data-timeline-detail="16@2026-09-24T19:00"[\s\S]*?<\/div>/.exec(sheet)[0];
  assert.ok(!detail16.includes('class="sr-only">, '), 'die Unterzeile nennt alle - kein zweiter Name hinter dem Avatar');
  // Aufgeklappt aus dem gemerkten Zustand: die Region und genau diese Zeile stehen.
  const open = dash.renderTodayCockpit(day, [], false, { timelineOpen: '15@2026-09-24T16:00' });
  assert.match(open, /id="today-timeline-detail">/);
  assert.match(open, /data-timeline-detail="15@2026-09-24T16:00">/);
  assert.match(open, /data-timeline-event="15@2026-09-24T16:00"\s+aria-expanded="true"/);
  assert.match(open, /data-timeline-detail="14@2026-09-24T20:15" hidden>/);
}));

test('Heute-Blatt: steht in der Leiste noch etwas aus, ist der Tag nicht „frei"; auf dem Telefon bleiben die Termine Zeilen', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const onlyEvents = { upcomingEvents: [ev(14, 'Filmabend', '2026-09-24T20:15', '2026-09-24T22:00')], urgentTasks: [], users: TIMELINE_USERS };
  const wide = dash.renderTodayCockpit(onlyEvents, []);
  assert.ok(!wide.includes('today-cockpit-card--state'), 'der Filmabend steht noch aus - weder „frei" noch „nichts mehr"');
  assert.match(wide, /today-timeline__title">Filmabend</);
  global.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), media: query });
  const phone = dash.renderTodayCockpit(onlyEvents, []);
  assert.match(phone, /today-cockpit-card__value">Filmabend</, 'ohne Leiste bleibt der Termin eine Zeile');
}));

// DER ENTWURF „HEUTE WICHTIG" IM EINZELNEN (Ulas, 2026-10-26: „wie bei Claude
// Design"). Kopf mit Siegel in der Karte, „in 25 Min" im Modulton, das
// Naechste zuerst, die Mahlzeit als Block in „Alle", die Achse kurz („07").
const THU_1805_BERLIN = '2026-09-24T16:05:00Z';

test('Entwurf „Heute wichtig": der Kopf steht mit Siegel und Summe in der Karte, im Anpassen-Modus darueber', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(timelineDay(), []);
  assert.match(sheet, /<div class="today-cockpit__grid">\s*<div class="today-cockpit__header">\s*<span class="module-seal today-cockpit__seal" aria-hidden="true"><i data-lucide="sun-moon"/);
  const editing = dash.renderTodayCockpit(timelineDay(), [], true);
  assert.match(editing, /today-cockpit--editing"[^>]*>\s*<div class="today-cockpit__header">/, 'im Anpassen-Modus steht er ueber der Karte - mobil klappt das Band dort auf ihn zusammen');
  assert.match(editing, /data-glance-hide/);
}));

test('Entwurf „Heute wichtig": das Abendessen um 18:30 steht vorn, „in 25 Min" im Modulton, als Block in „Alle"', inBrowser(THU_1805_BERLIN, 'Europe/Berlin', () => {
  const day = {
    ...timelineDay(),
    todayMeals: [{ id: 9, meal_type: 'dinner', title: 'Lachs & Ofengemuese' }],
    urgentTasks: [
      { id: 21, title: 'Stromrechnung', due_date: '2026-09-22', status: 'open', assigned_users: [] },
      { id: 22, title: 'Zettel', due_date: '2026-09-23', status: 'open', assigned_users: [] },
      { id: 23, title: 'Formular', due_date: '2026-09-23', status: 'open', assigned_users: [] },
    ],
  };
  const sheet = dash.renderTodayCockpit(day, []);
  const strip = /today-cockpit__rows--next"[^>]*>([\s\S]*?)<\/div>\s*<div class="today-cockpit__rows--more|today-cockpit__rows--next"[^>]*>([\s\S]*)/.exec(sheet);
  const cells = [...(strip[1] ?? strip[2]).matchAll(/today-cockpit-card__value">([^<]*)</g)].map((m) => m[1]);
  assert.equal(cells[0], 'Lachs &amp; Ofengemuese', 'das Naechste zuerst, vor dem Ueberfaelligen - auch wenn der Deckel es verdeckt haette');
  assert.match(sheet, /today-cockpit-card__time today-cockpit-card__time--soon">[^<]*25[^<]*</, '„in 25 Min" im Modulton');
  assert.match(sheet, /data-timeline-event="meal-9"/, 'die Mahlzeit steht als Block in der Leiste');
  assert.match(sheet, /--c:var\(--module-meals\)/, 'im Ton der Kueche');
  assert.match(sheet, /--c:var\(--module-calendar\)/, 'Termine im Ton des Kalenders');
  assert.match(sheet, /today-timeline__hour[^"]*" data-minute="420"[^>]*>07</, 'die Achse kurz: „07" statt „07:00"');
  assert.match(sheet, /today-timeline__hour[^"]*--covered" data-minute="1080"/, 'die Stunde unter der Jetzt-Pille schweigt');
}));
