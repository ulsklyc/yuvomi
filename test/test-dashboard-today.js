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
import { readFileSync, readdirSync } from 'node:fs';
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
  // Seit DW-P2-10 ist der Tag das erste Wort der Metazeile ("Heute · 17:00 ·
  // Ort"), nicht mehr eine Pille davor; `badge` liest dieses Wort.
  return [...html.matchAll(/<div class="list-row event-item([^"]*)"[\s\S]*?event-item__title">([^<]*)<\/div>[\s\S]*?event-item__time">([\s\S]*?)<\/div>/g)]
    .map(([, cls, title, time]) => ({
      title,
      ended: cls.includes('event-item--ended'),
      badge: (/event-item__when[^>]*>([^<]*)</.exec(time) || [])[1],
      time: time.replace(/<span[^>]*>[^<]*<\/span>/g, '').replace(/\s+/g, ' ').trim().replace(/^·\s*/, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
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
  const statusOf = (name) => (new RegExp(`family-member__name">${name}</span>\\s*<span class="list-row__meta family-member__status[^"]*">([^<]*)<`).exec(html) || [])[1];
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
  // Seit der Critique 2026-10-26 (Befund 4, Ulas) nennt der zugaengliche Name
  // eines Blocks auch das Ende; SICHTBAR bleibt es in Block und Liste der Wand
  // vorbehalten. Nur die aufgeklappte Zeile eines Blocks nennt die Spanne
  // (Lauf 2) - sie steht allein und erklaert die Breite des Blocks.
  const [, detail = ''] = /id="today-timeline-detail"[^>]*>([\s\S]*)$/.exec(sheet) ?? [];
  const visible = sheet.replace(detail, '').replace(/<span class="sr-only">[^<]*<\/span>/g, '');
  assert.ok(detail, 'Reichweite: die Leiste steht mit ihrer Detailregion');
  assert.ok(!visible.includes('2026-09-24T22:00'), 'kein sichtbares Ende im Blatt: die Spanne bleibt der Wand vorbehalten');
  assert.match(detail, /today-cockpit-card__time">2026-09-24T14:00 - 2026-09-24T22:00</, 'die aufgeklappte Zeile nennt Beginn und Ende');
  assert.match(sheet, /<span class="sr-only">,? dashboard\.todayUntil\{(?:"|&quot;)time(?:"|&quot;):(?:"|&quot;)2026-09-24T22:00(?:"|&quot;)\}<\/span>/, 'der Screenreader hoert, bis wann');
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
const timelineOf = (html) => (/<div class="today-timeline[\s\S]*?id="today-timeline-detail"/.exec(html) || [''])[0];

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
  assert.match(timeline, /today-timeline__event--past"[^>]*>\s*<span class="sr-only">Alex: <\/span><span class="today-timeline__title">Zahnarzt<[\s\S]*?dashboard\.todayTimelinePast/);
  assert.match(timeline, /today-timeline__event--now"[^>]*>\s*<span class="sr-only">Emma: <\/span><span class="today-timeline__title">Schule</);
  // Ganztaegiges hat keinen Block auf der Achse, sondern steht im Band darueber (Critique, Befund 3).
  assert.ok(!/today-timeline__slot[^>]*>\s*<button[^>]*>\s*<span class="sr-only">[^<]*<\/span><span class="today-timeline__title">Ausflug</.test(timeline));
  assert.match(timeline, /today-timeline__allday[\s\S]*?today-timeline__title">Ausflug</);
  // Nur der Beginn (#1698), das Ende traegt die Breite.
  assert.ok(!timeline.replace(/<span class="sr-only">[^<]*<\/span>/g, '').includes('2026-09-24T13:00'), 'sichtbar nur der Beginn');
  assert.match(timeline, /<span class="sr-only"> dashboard\.todayUntil\{(?:"|&quot;)time(?:"|&quot;):(?:"|&quot;)2026-09-24T13:00/, 'das Ende hoert der Screenreader (Befund 4)');
  // 10:00 auf der Achse 07-22.
  assert.match(timeline, /--tl-now:0\.2(?![\d])|--tl-now:0\.19999/);
  assert.match(sheet, /today-cockpit__summary">dashboard\.todaySummaryEventsAhead\{&quot;count&quot;:4\} · dashboard\.todaySummaryOverdue\{&quot;count&quot;:1\}</,
    'noch vier Termine samt laufendem und ganztaegigem (der Zahnarzt ist vorbei), eine ueberfaellige Aufgabe');
}));

test('Heute-Blatt: keine Zeitleiste neben der Termin-Kachel, auf dem Telefon nur die Kurzfassung', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const withTile = dash.renderTodayCockpit(timelineDay(), [{ id: 'calendar', visible: true }]);
  assert.ok(!withTile.includes('today-timeline'), 'die Leiste waere das Echo der Kachel');
  assert.ok(!withTile.includes('todaySummaryEventsAhead'), 'und die Termine zaehlt die Kachel');
  assert.match(withTile, /todaySummaryOverdue/, 'das Ueberfaellige spricht weiter, solange die Aufgaben im Blatt sprechen');
  global.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), media: query });
  const phone = dash.renderTodayCockpit(timelineDay(), []);
  // Mobil die Kurzfassung des Entwurfs: Bild, ohne Knoepfe und ohne Text in
  // den Balken - die Termine bleiben Zeilen.
  assert.match(phone, /<div class="today-timeline today-timeline--mini" aria-hidden="true"/);
  assert.ok(!phone.includes('data-timeline-event'), 'kein Tippziel in einem 10px-Balken');
  // Die Termine kommen aus dem Bild (D1) und fuehren (D6): zwei Zeilen Deckel,
  // das Ganztaegige zuerst, dann die laufende Schule. Fussball (nur in der
  // Familienliste), Filmabend und die ueberfaellige Aufgabe stehen hinter
  // „+3 weitere" - gemischt, also zum Aufklappen statt am Kalendertag.
  const shown = phone.slice(0, phone.indexOf('id="today-cockpit-more"'));
  assert.deepEqual([...shown.matchAll(/today-cockpit-card__value">([^<]*)</g)].map((m) => m[1]), ['Ausflug', 'Schule']);
  assert.match(phone, /id="today-cockpit-more" hidden>[\s\S]*?today-cockpit-card__value">Fussball</, 'der Fussball steht als Zeile');
  assert.match(phone, /<button type="button" class="today-cockpit__more[\s\S]*?dashboard\.todayMore\{&quot;count&quot;:3\}/);
}));

test('Heute-Blatt: ein Termin der Zeitleiste steht nicht noch einmal in der Liste - sein Block klappt die Zeile auf', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const day = timelineDay();
  day.upcomingEvents.push(ev(16, 'Elternabend', '2026-09-24T19:00', '2026-09-24T20:30', { assigned_users: [person(1), person(2)] }));
  const sheet = dash.renderTodayCockpit(day, []);
  const list = sheet.slice(sheet.indexOf('class="today-cockpit__rows'));
  // Seit der Critique (Befund 3) steht auch das Ganztaegige in der Leiste - als
  // Band ueber der Achse; die Liste traegt keinen dieser Termine mehr.
  assert.match(sheet, /<div class="today-timeline__allday">[\s\S]*?today-timeline__title">Ausflug</);
  for (const title of ['Ausflug', 'Schule', 'Filmabend', 'Fussball', 'Elternabend']) {
    assert.ok(!list.includes(`today-cockpit-card__value">${title}<`), `${title} steht nur in der Leiste`);
  }
  // Der Block ist ein Aufklapp-Knopf auf die Zeile darunter, zugeklappt bis zum Klick.
  assert.match(sheet, /<button type="button" class="today-timeline__event today-timeline__event--next" data-timeline-event="14@2026-09-24T20:15" tabindex="-1"\s+aria-expanded="false" aria-controls="today-timeline-detail" title="Filmabend · [^"]*">/);
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

test('Critique 2026-10-26: das Abendessen ist ein Punkt, als Naechstes markiert, und steht nicht noch einmal im Streifen', inBrowser(THU_1805_BERLIN, 'Europe/Berlin', () => {
  const day = {
    ...timelineDay(),
    todayMeals: [{ id: 9, meal_type: 'dinner', title: 'Lachs & Ofengemuese' }],
  };
  const sheet = dash.renderTodayCockpit(day, []);
  const meal = /<button type="button" class="([^"]*)" data-timeline-event="meal-9"([^>]*)>([\s\S]*?)<\/button>/.exec(sheet);
  assert.ok(meal, 'die Mahlzeit steht in der Leiste');
  assert.match(meal[1], /today-timeline__event--point/, 'als Punkt, ohne erfundene Dauer');
  assert.match(meal[1], /today-timeline__event--upnext/, 'das Naechste spricht in der Leiste (Befund 2)');
  assert.ok(!/today-timeline__event--now/.test(meal[1]), 'eine Mahlzeit „laeuft" nie');
  assert.match(meal[2], /^\s*aria-expanded/, 'der eine Tab-Stopp der Leiste ist das Naechste (kein tabindex=-1)');
  assert.match(meal[3], /dashboard\.todayTimelineNext/, 'der Screenreader hoert „als Naechstes"');
  assert.equal((sheet.match(/data-timeline-event="[^"]*"(?! tabindex="-1")\s+aria-expanded/g) ?? []).length, 1, 'genau EIN Tab-Stopp in der Leiste');
  assert.match(sheet, /<p class="today-cockpit__also">dashboard\.todayAlsoTitle<\/p>/, 'der Streifen heisst „Ausserdem heute"');
  const list = sheet.slice(sheet.indexOf('class="today-cockpit__rows'));
  assert.ok(!list.includes('Lachs'), 'die Mahlzeit steht nicht noch einmal im Streifen');
  assert.match(sheet, /--c:var\(--module-meals\)/, 'im Ton der Kueche');
  assert.match(sheet, /--c:var\(--module-calendar\)/, 'Termine im Ton des Kalenders');
  assert.match(sheet, /today-timeline__hour[^"]*" data-minute="420"[^>]*>07</, 'die Achse kurz: „07" statt „07:00"');
  assert.match(sheet, /today-timeline__hour[^"]*--covered" data-minute="1080"/, 'die Stunde unter der Jetzt-Pille schweigt');
  assert.match(sheet, /<span class="sr-only">Emma(?: Johnson)?: <\/span><span class="today-timeline__title">Schule</, 'der Name nennt die Person (Befund 4)');

  // Unter der breiten Buehne: Kurzfassung, und die Mahlzeit ist die erste
  // Zeile mit Uhrzeit (D6: das Ganztaegige steht davor) - „in 25 Min" im Modulton.
  const compact = dash.renderTodayCockpit(day, [], false, { stage: 'compact' });
  assert.match(compact, /today-timeline--mini" aria-hidden="true"/);
  const order = [...compact.slice(compact.indexOf('class="today-cockpit__rows')).matchAll(/today-cockpit-card__value">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 2), ['Ausflug', 'Lachs &amp; Ofengemuese'], 'Ganztaegiges, dann das Naechste');
  assert.match(compact, /today-cockpit-card__time today-cockpit-card__time--soon">[^<]*25[^<]*</, '„in 25 Min" im Modulton');
  assert.match(compact, /today-cockpit-card__value">Filmabend<[\s\S]*?today-cockpit-card__time">[^<]*20:15 · [^<]*</, 'spaeter mit Uhrzeit davor: „20:15 · in 2 Std."');
  assert.ok(!compact.includes('<p class="today-cockpit__also">'), 'ohne Leiste nicht die Ueberschrift des Streifens');
  assert.match(compact, /<h3 class="today-cockpit__also today-cockpit__also--row">dashboard\.todayAlsoTitle<\/h3>[\s\S]*?Stromrechnung/, 'die Aufgabe steht unter „Ausserdem heute" (D6)');
}));

test('Critique 2026-10-26: die eigene Schicht steht als Block in der eigenen Spur und nicht noch einmal in der Liste', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const day = {
    ...timelineDay(),
    myShiftsToday: [{ date_key: '2026-09-24', shift_type: { id: 7, name: 'Fruehschicht', short_code: 'F', start_time: '06:00', end_time: '14:00' } }],
  };
  const viewer = TIMELINE_USERS[1];
  const sheet = dash.renderTodayCockpit(day, [], false, { viewer });
  const lanes = [...sheet.matchAll(/today-timeline__name">([^<]*)<\/span><\/span>\s*<ul class="today-timeline__track" aria-label="[^"]*">([\s\S]*?)<\/ul>/g)];
  const linda = lanes.find((m) => m[1].startsWith('Linda'));
  assert.ok(linda, 'Linda bekommt eine Spur - durch ihre Schicht');
  assert.match(linda[2], /data-timeline-event="shift-7"/);
  assert.match(linda[2], /--c:var\(--module-schedule\)/, 'im Ton des Schichtplans');
  assert.match(linda[2], /today-timeline__event--now/, 'sie laeuft um 10:00');
  const list = sheet.slice(sheet.indexOf('class="today-cockpit__rows'));
  assert.ok(!list.includes('today-cockpit-card--schedule'), 'die Schicht steht nicht noch einmal in der Liste');
  // Die Achse beginnt mit der Schicht um 06:00.
  assert.match(sheet, /data-timeline-start="360"/);
}));


// BILD UND TEXT ERZAEHLEN DENSELBEN TAG (Critique 2026-10-26, Lauf 2, D1).
// Gemessen um 14:30 auf compact und phone: die Haelfte der Balken der
// Kurzfassung kam im Blatt nie als Text vor (Filmabend 20:00 nur in der
// Familienliste, Snack, Abendessen), dafuer standen das vergangene
// Mittagessen und die beendete Fruehschicht noch als Zeilen. Jetzt speisen
// die kommenden Eintraege der Leiste die Zeilen.
const THU_1430_BERLIN = '2026-09-24T12:30:00Z';
const busyAfternoon = () => ({
  upcomingEvents: [
    ev(41, 'Kita abholen', '2026-09-24T15:00', '2026-09-24T15:30', { assigned_users: [person(3)] }),
    ev(42, 'Elternabend', '2026-09-24T19:00', '2026-09-24T20:30', { assigned_users: [person(1), person(2)] }),
    ev(43, 'Ausflug', '2026-09-24', '2026-09-24', { all_day: 1 }),
  ],
  familyEvents: [
    // Beendet: steht im Bild als vergangener Balken, nicht als Zeile.
    ev(44, 'Zahnarzt', '2026-09-24T08:30', '2026-09-24T09:30', { assigned_users: [person(1)] }),
    ev(42, 'Elternabend', '2026-09-24T19:00', '2026-09-24T20:30', { assigned_users: [person(1), person(2)] }),
    // Hinter dem Deckel der Kachel: nur die Familienliste kennt ihn.
    ev(45, 'Filmabend', '2026-09-24T20:00', '2026-09-24T22:00', { assigned_users: [person(4)] }),
  ],
  todayMeals: [
    { id: 61, meal_type: 'lunch', title: 'Linsensuppe' },
    { id: 62, meal_type: 'snack', title: 'Apfelschnitze' },
    { id: 63, meal_type: 'dinner', title: 'Ofengemuese' },
  ],
  myShiftsToday: [{ date_key: '2026-09-24', shift_type: { id: 7, name: 'Fruehschicht', short_code: 'F', start_time: '06:00', end_time: '14:00' } }],
  urgentTasks: [],
  users: TIMELINE_USERS,
});
const reachableText = (html) => html.slice(html.indexOf('class="today-cockpit__rows'));
const eventRowIds = (html) => [...html.matchAll(/data-object-kind="event" data-object-id="(\d+)"/g)].map((m) => Number(m[1]));
const summaryEvents = (html) => Number(/todaySummaryEventsAhead\{&quot;count&quot;:(\d+)\}/.exec(html)?.[1] ?? 0);
const onPhone = () => { global.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), media: query }); };

for (const stage of ['compact', 'phone']) {
  test(`D1 (${stage}): die Zeilen kommen aus der Leiste - Kommendes als Text, Vergangenes nicht`, inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
    if (stage === 'phone') onPhone();
    const viewer = TIMELINE_USERS[1];
    // Aufgeklappt, damit auch die Zeilen hinter „+N weitere" als Text dastehen;
    // mit drei Zeilen Deckel sind Mahlzeit und Termine verdeckt, also gemischt
    // und hier aufzuklappen statt am Kalendertag (D6: die Leiste fuehrt).
    const sheet = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage, viewer, moreOpen: true, cap: 3 });
    assert.equal(/data-today-stage="([^"]+)"/.exec(sheet)?.[1], stage, 'Vorbedingung: die Buehne');
    assert.match(sheet, /today-timeline--mini" aria-hidden="true"/, 'Vorbedingung: die Kurzfassung steht');
    const text = reachableText(sheet);
    assert.match(text, /today-cockpit-card__value">Filmabend</, 'der Filmabend aus der Familienliste ist als Text erreichbar');
    assert.match(text, /today-cockpit-card__value">Apfelschnitze</, 'der Snack um 15:30 steht als Zeile');
    assert.match(text, /today-cockpit-card__value">Ofengemuese</, 'das Abendessen um 18:30 steht als Zeile');
    assert.ok(!text.includes('Linsensuppe'), 'das Mittagessen um 12:30 ist vorbei');
    assert.ok(!text.includes('data-object-kind="shift"'), 'die Fruehschicht endete um 14:00');
    assert.ok(!text.includes('Zahnarzt'), 'der beendete Termin bleibt Bild');
    assert.match(text, /today-cockpit-card__value">Ausflug</, 'das Ganztaegige bleibt Zeile');
    const ids = eventRowIds(text);
    assert.equal(ids.filter((id) => id === 42).length, 1, 'der Elternabend fuer zwei steht genau einmal als Zeile');
    assert.deepEqual([...ids].sort(), [41, 42, 43, 45], 'genau die kommenden Termine des Tages');
    assert.equal(summaryEvents(sheet), ids.length, 'der Kopf zaehlt die Termine, die man lesen kann');
  }));
}

test('D1: steht der Rest am Kalendertag, zaehlt der Kopf sichtbare und verdeckte Termine wie „+N weitere"', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const day = { ...busyAfternoon(), todayMeals: [], myShiftsToday: [] };
  const sheet = dash.renderTodayCockpit(day, [], false, { stage: 'compact', cap: 2 });
  const more = /<a href="\/calendar\?date=2026-09-24" class="today-cockpit__more[\s\S]*?dashboard\.todayMore\{&quot;count&quot;:(\d+)\}/.exec(sheet);
  assert.ok(more, 'Vorbedingung: nur Termine verdeckt - „+N weitere" fuehrt an den Kalendertag');
  assert.equal(eventRowIds(reachableText(sheet)).length + Number(more[1]), summaryEvents(sheet));
  assert.equal(summaryEvents(sheet), 4, 'Kita, Elternabend, Ausflug, Filmabend - ohne den beendeten Zahnarzt');
}));

test('D1: die laufende eigene Schicht steht unter der breiten Buehne einmal als Zeile', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'compact', viewer: TIMELINE_USERS[1], moreOpen: true });
  assert.equal(reachableText(sheet).match(/data-object-kind="shift"/g)?.length, 1, 'aus der Leiste, nicht noch einmal aus dem Beitrag');
}));

test('D1: breit bleibt es - getimte Termine nur in der Leiste, der Kopf zaehlt, was noch kommt (D5)', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'wide', viewer: TIMELINE_USERS[1], moreOpen: true });
  assert.equal(eventRowIds(reachableText(sheet)).length, 0, 'keine Terminzeile neben der Leiste');
  assert.match(sheet, /today-timeline__title">Filmabend</, 'der Filmabend steht in der Leiste');
  assert.match(sheet, /today-timeline__title">Zahnarzt</, 'der beendete Zahnarzt steht im Bild');
  assert.equal(summaryEvents(sheet), 4, 'aber nicht in der Zahl - sie sagt „noch"');
}));

test('D1: verstreicht die Zeit einer Mahlzeit, baut der Minutentakt neu', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: [], familyEvents: [], todayMeals: [{ id: 63, meal_type: 'dinner', title: 'Ofengemuese' }] };
  const before = dash.todayFingerprint(data, [], new Date('2026-09-24T16:29:00Z'));
  const after = dash.todayFingerprint(data, [], new Date('2026-09-24T16:31:00Z'));
  assert.notEqual(before, after, 'um 18:30 verlaesst das Abendessen die Zeilen der Kurzfassung');
}));


// DAS NAECHSTE SPRICHT, AUSWAHL, FOKUS, BEWEGUNG (Critique 2026-10-26, Lauf 2,
// D2 und P2). Die Fahne, ihr Minutentakt und ihre Lage, die Verdrahtung der
// Leiste gegen ein nachgebautes DOM, der Fokus ueber den Buehnenwechsel und
// die Regeln des Stylesheets, die sich ohne Browser lesen lassen. Was nur das
// Auge pruefen kann (Ringe, Kante, Fuge), prueft die Sichtpruefung.
const dashboardCss = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
/** Der Rumpf der ERSTEN Regel, deren Selektorliste genau `selector` ist (ab `from`). */
const cssRule = (selector, from = 0) => {
  const at = dashboardCss.indexOf(`\n${selector} {`, from);
  return at < 0 ? null : dashboardCss.slice(dashboardCss.indexOf('{', at) + 1, dashboardCss.indexOf('\n}', at));
};

test('Lauf 2, D2: das Naechste traegt eine Fahne in der Achse - nur es, aria-hidden, im Modulton, mit seiner Relativzeit', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(timelineDay(), []);
  const flags = [...sheet.matchAll(/<span class="today-timeline__flag"([^>]*)>([^<]*)<\/span>/g)];
  assert.equal(flags.length, 1, 'genau eine Fahne');
  const [, attrs, label] = flags[0];
  assert.match(attrs, /aria-hidden="true"/, 'Bild - den Satz traegt der Block');
  assert.match(attrs, /data-flag-at="960"/, 'am Fussball um 16:00, dem Naechsten');
  assert.match(attrs, /--c:var\(--module-calendar\)/, 'im Ton des Kalenders, nicht im Akzent der Jetzt-Pille');
  const slot = /<li class="today-timeline__slot" data-timeline-at="960" style="--tl-left:([^;]+);/.exec(sheet);
  assert.ok(slot, 'Vorbedingung: der Fussball-Block steht in der Leiste');
  assert.match(attrs, new RegExp(`--tl-at:${slot[1].replace('.', '\\.')};`), 'ueber dem Blockanfang');
  // formatTime reicht im Stub den Zeitstempel durch.
  assert.match(label, /^2026-09-24T16:00 · \S/, 'spaeter als eine Stunde: Uhrzeit, dann die Relativzeit');
  const axis = /<div class="today-timeline__axis" aria-hidden="true">([\s\S]*?)<\/div>/.exec(sheet)[1];
  assert.ok(axis.includes('today-timeline__flag'), 'in der Achse');
  // EINE Quelle: der Block nennt seine Zeit nicht noch einmal sichtbar.
  const block = /<button type="button" class="[^"]*today-timeline__event--upnext[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(sheet)[1];
  assert.ok(!block.includes('today-timeline__time'), 'keine sichtbare Zeit im Block neben der Fahne');
  assert.ok(block.includes(`<span class="sr-only" data-timeline-when>, ${label}</span>`), 'der zugaengliche Name behaelt sie - dieselbe Auskunft');
  assert.match(block, /dashboard\.todayTimelineNext/);
  // Ohne Kommendes keine Fahne.
  const late = dash.renderTodayCockpit(timelineDay(), [], false, { now: new Date('2026-09-24T20:30:00Z') });
  assert.ok(!late.includes('today-timeline__flag'), 'um 22:30 kommt nichts mehr');
}));

test('Lauf 2, D2: die Fahne weicht der Jetzt-Pille aus und bleibt in der Achse - das Stylesheet entscheidet, die Breiten sind gemessen', () => {
  const rule = cssRule('.today-timeline__flag');
  assert.ok(rule, 'die Fahne hat eine Regel');
  const body = /inset-inline-start:\s*clamp\(([\s\S]*?)\);/.exec(rule)?.[1] ?? '';
  // Die drei Argumente, getrennt an Kommas der obersten Klammerebene.
  const clamp = ['', ''];
  let depth = 0;
  for (const ch of body) {
    if (ch === ',' && depth === 0) { clamp.push(''); continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    clamp[clamp.length - 1] += ch;
  }
  assert.equal(clamp.length, 4, 'die Lage ist ein clamp() aus drei Teilen');
  assert.match(clamp[1], /var\(--tl-now[,)][\s\S]*var\(--tl-now-half/, 'untere Grenze: hinter der Jetzt-Pille - sie gewinnt, wenn beide Grenzen kollidieren');
  assert.match(clamp[2], /var\(--tl-at\)/, 'bevorzugt: der Blockanfang');
  assert.match(clamp[3], /100% - var\(--tl-flag-w/, 'obere Grenze: endet spaetestens am Achsenende');
  assert.match(rule, /color-mix\(in srgb, var\(--c\) var\(--tint-ink\), var\(--color-text-primary\)\)/, 'Tinte aus der Toenungsleiter');
  assert.match(rule, /background: color-mix\(in srgb, var\(--c\) var\(--tint-raised\), var\(--color-surface\)\)/);
  assert.match(cssRule('.today-timeline__hour--flagged') ?? '', /visibility: hidden/, 'die Stunde unter der Fahne schweigt');

  // Die Messung dazu: halbe Pille plus Fuge, die eigene Breite, die verdeckten Stunden.
  const style = new Map();
  const rect = (left, width) => ({ left, right: left + width, width });
  const hour = (minute, left) => {
    const classes = new Set();
    return { dataset: { minute: String(minute) }, classes, getBoundingClientRect: () => rect(left, 14), classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  };
  const hours = [hour(900, 400), hour(960, 452), hour(1020, 505)];
  const flag = { hidden: false, style: { setProperty: (k, v) => style.set(k, v) }, getBoundingClientRect: () => rect(455, 60) };
  const timeline = {
    querySelector: (sel) => ({ '[data-timeline-flag]': flag, '.today-timeline__now-time': { getBoundingClientRect: () => rect(380, 40) } })[sel] ?? null,
    querySelectorAll: (sel) => (sel === '.today-timeline__hour[data-minute]' ? hours : []),
  };
  dash.placeTodayTimelineFlag(timeline);
  assert.equal(style.get('--tl-now-half'), '24px', 'halbe Pille (20) plus Fuge (4)');
  assert.equal(style.get('--tl-flag-w'), '60px');
  assert.deepEqual(hours.map((h) => h.classes.has('today-timeline__hour--flagged')), [false, true, true], '15 bleibt, 16 und 17 liegen unter der Fahne');
});

test('Lauf 2, D2: der Minutentakt zaehlt die Fahne herunter - samt zugaenglichem Namen - und laesst sie schweigen, sobald es begonnen hat', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const style = new Map();
  const flag = { hidden: false, textContent: '16:00 · in 6 Std.', dataset: { flagAt: '960', flagClock: '16:00' }, style: { setProperty: (k, v) => style.set(k, v) }, getBoundingClientRect: () => ({ left: 0, right: 60, width: 60 }) };
  const spoken = [{ textContent: ', 16:00 · in 6 Std.' }, { textContent: ', 16:00 · in 6 Std.' }];
  const timeline = {
    dataset: { timelineStart: '420', timelineEnd: '1320' },
    style: { setProperty: (k, v) => style.set(k, v) },
    querySelector: (sel) => (sel === '[data-timeline-flag]' ? flag : null),
    querySelectorAll: (sel) => (sel === '[data-timeline-when]' ? spoken : []),
  };
  const root = { querySelector: (sel) => (sel === '.today-timeline' ? timeline : null) };
  dash.updateTodayTimelineNow(root, new Date('2026-09-24T13:35:00Z'));
  assert.match(flag.textContent, /25/, 'um 15:35: „in 25 Min."');
  assert.ok(!flag.textContent.includes('16:00'), 'unter einer Stunde ohne Uhrzeit');
  assert.ok(spoken.every((s) => s.textContent === `, ${flag.textContent}, 16:00`), 'beide Bloecke (zwei Spuren) hoeren es mit der Uhrzeit dahinter');
  assert.equal(flag.hidden, false);
  dash.updateTodayTimelineNow(root, new Date('2026-09-24T14:01:00Z'));
  assert.equal(flag.hidden, true, 'um 16:01 hat der Fussball begonnen');
}));

test('Lauf 2, D2: beginnt das Naechste, baut der Minutentakt neu - der Block laeuft, der naechste bekommt die Fahne', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const before = dash.todayFingerprint(timelineDay(), [], new Date('2026-09-24T13:59:00Z'));
  const after = dash.todayFingerprint(timelineDay(), [], new Date('2026-09-24T14:01:00Z'));
  assert.notEqual(before, after, 'um 16:00 beginnt der Fussball - es endet nichts, und doch ist es ein anderer Stand');
  const sheet = dash.renderTodayCockpit(timelineDay(), [], false, { now: new Date('2026-09-24T14:01:00Z') });
  assert.match(sheet, /<span class="today-timeline__flag"[^>]*data-flag-at="1215"/, 'die Fahne steht jetzt am Filmabend');
}));

/** Ein nachgebautes DOM der Leiste: Spuren (Listen) mit Bloecken, Detailzeilen je Schluessel. */
function fakeTimeline(lanes) {
  const log = { focused: null };
  const buttons = [];
  for (const [laneIndex, entries] of lanes.entries()) {
    const lane = { lane: laneIndex };
    for (const { key, at } of entries) {
      const attrs = { 'aria-expanded': 'false', tabindex: '-1' };
      const handlers = {};
      const slot = at == null ? null : { dataset: { timelineAt: String(at) } };
      const btn = {
        name: `${laneIndex}:${key}`,
        dataset: { timelineEvent: key },
        attrs,
        setAttribute: (n, v) => { attrs[n] = String(v); },
        getAttribute: (n) => attrs[n] ?? null,
        addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
        closest: (sel) => (sel === 'ul' ? lane : sel === '[data-timeline-at]' ? slot : null),
        focus: () => { log.focused = btn; },
        fire: (type, key2) => {
          const e = { key: key2, prevented: false, preventDefault() { e.prevented = true; } };
          for (const fn of handlers[type] ?? []) fn(e);
          return e;
        },
      };
      buttons.push(btn);
    }
  }
  const rows = [...new Set(buttons.map((b) => b.dataset.timelineEvent))]
    .map((key) => ({ dataset: { timelineDetail: key }, hidden: true }));
  const regionHandlers = {};
  const region = {
    hidden: true,
    querySelectorAll: (sel) => (sel === '[data-timeline-detail]' ? rows : []),
    addEventListener: (type, fn) => { (regionHandlers[type] ??= []).push(fn); },
    fire: (type, key) => {
      const e = { key, prevented: false, preventDefault() { e.prevented = true; } };
      for (const fn of regionHandlers[type] ?? []) fn(e);
      return e;
    },
  };
  const root = {
    querySelector: (sel) => (sel === '#today-timeline-detail' ? region : null),
    querySelectorAll: (sel) => (sel === '[data-timeline-event]' ? buttons : []),
  };
  const find = (name) => buttons.find((b) => b.name === name);
  return { root, region, rows, buttons, find, log };
}

test('Lauf 2, P2: Esc gibt den Fokus dem Block zurueck, der aufgeklappt hat - beim Termin fuer zwei in dessen Spur', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const { root, region, rows, find, log } = fakeTimeline([
    [{ key: 'k1', at: 960 }],
    [{ key: 'k1', at: 960 }, { key: 'k2', at: 1215 }],
  ]);
  dash.wireTodayTimeline(root);
  find('1:k1').fire('click');
  assert.equal(region.hidden, false, 'die Zeile steht');
  assert.deepEqual(rows.map((r) => r.hidden), [false, true]);
  assert.equal(find('0:k1').attrs['aria-expanded'], 'true', 'beide Bloecke des Termins sagen „aufgeklappt"');
  const e = region.fire('keydown', 'Escape');
  assert.ok(e.prevented);
  assert.equal(log.focused, find('1:k1'), 'zurueck in die zweite Spur, nicht in die erste');
  assert.equal(find('1:k1').attrs.tabindex, '0', 'und er ist der Tab-Stopp');
  assert.equal(region.hidden, true, 'zugeklappt');
}));

test('Lauf 2, P2: hoch/runter wechseln die Spur zum naechstgelegenen Beginn, links/rechts bleiben in der Lesereihenfolge', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const { root, find, log } = fakeTimeline([
    [{ key: 'ganztag' }],
    [{ key: 'a', at: 480 }, { key: 'b', at: 960 }],
    [{ key: 'c', at: 600 }, { key: 'd', at: 1000 }],
  ]);
  dash.wireTodayTimeline(root);
  const press = (name, key) => { log.focused = null; return find(name).fire('keydown', key); };
  assert.ok(press('1:b', 'ArrowDown').prevented);
  assert.equal(log.focused?.name, '2:d', 'von 16:00 zu 16:40, nicht zu 10:00');
  press('2:c', 'ArrowUp');
  assert.equal(log.focused?.name, '1:a', 'von 10:00 zu 08:00 (zwei Stunden), nicht zu 16:00');
  press('1:a', 'ArrowUp');
  assert.equal(log.focused?.name, '0:ganztag', 'ueber der ersten Spur liegt das Band');
  press('0:ganztag', 'ArrowDown');
  assert.equal(log.focused?.name, '1:a', 'aus dem Band (ohne Beginn) in den ersten Block');
  const edge = press('2:d', 'ArrowDown');
  assert.ok(edge.prevented, 'die Seite scrollt nicht');
  assert.equal(log.focused, null, 'unter der letzten Spur bleibt der Fokus');
  press('1:b', 'ArrowRight');
  assert.equal(log.focused?.name, '2:c', 'rechts: der naechste in Lesereihenfolge');
  press('2:c', 'ArrowLeft');
  assert.equal(log.focused?.name, '1:b');
}));

test('Lauf 2, P2: die Zeile gleitet auf und zu wie „+N weitere"; der Wechsel bei offener Zeile blendet nur die Zeile ueber', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const before = globalThis.__motionStub;
  const moves = [];
  globalThis.__motionStub = (name, host, arg) => moves.push([name, host?.dataset?.timelineDetail ?? (host ? 'region' : null), arg]);
  try {
    const { root, region, rows, find } = fakeTimeline([[{ key: 'k1', at: 960 }, { key: 'k2', at: 1215 }]]);
    dash.wireTodayTimeline(root);
    find('0:k1').fire('click');
    assert.deepEqual(moves, [['toggleRegion', 'region', true]], 'auf: ueber toggleRegion, die Regel von „+N weitere"');
    assert.equal(region.hidden, false);
    moves.length = 0;
    find('0:k2').fire('click');
    assert.deepEqual(rows.map((r) => r.hidden), [true, false]);
    assert.deepEqual(moves, [['swapContent', 'k2', {}], ['toggleRegion', 'region', true]],
      'Wechsel: nur die neue Zeile blendet (swapContent), die Region bleibt offen - ein laufendes Zuklappen haelt an');
    moves.length = 0;
    find('0:k2').fire('click');
    assert.deepEqual(moves, [['toggleRegion', 'region', false]], 'zu: ebenso');
    assert.equal(region.hidden, true);
  } finally {
    globalThis.__motionStub = before;
  }
}));

test('Lauf 2, P2: die aufgeklappte Zeile nennt Beginn - Ende; der Punkt nur seinen Beginn; die Zeit steht am Titel', inBrowser(THU_1805_BERLIN, 'Europe/Berlin', () => {
  const day = { ...timelineDay(), todayMeals: [{ id: 9, meal_type: 'dinner', title: 'Lachs' }] };
  const sheet = dash.renderTodayCockpit(day, []);
  const detail = (key) => new RegExp(`data-timeline-detail="${key}"[^>]*>([\\s\\S]*?)</(?:a|button)>`).exec(sheet)?.[1] ?? '';
  assert.match(detail('14@2026-09-24T20:15'), /today-cockpit-card__time">2026-09-24T20:15 - 2026-09-24T22:00</, 'der Filmabend: 20:15 - 22:00');
  assert.match(detail('14@2026-09-24T20:15'), /today-cockpit-card__value">Filmabend</, 'mit dem vollen Titel');
  const meal = detail('meal-9');
  assert.match(meal, /today-cockpit-card__time">18:30</, 'die Mahlzeit: nur ihre Zeit');
  assert.ok(!meal.includes(' - '), 'kein Ende am Punkt');
  assert.match(meal, /today-cockpit-card__sub">[^<·]+</, 'die Unterzeile traegt nur die Art, die Zeit steht rechts');
  // Die Liste bleibt beim Beginn allein (#1698).
  const compact = dash.renderTodayCockpit(day, [], false, { stage: 'compact' });
  assert.ok(!/today-cockpit__rows[\s\S]*2026-09-24T20:15 - /.test(compact), 'die Zeile der Liste nennt keine Spanne');
  const row = cssRule('.today-timeline__detail-row > .today-cockpit-card');
  assert.match(row, /grid-template-columns:[^;]*minmax\(0, max-content\) auto;/, 'die Zeit folgt dem Titel');
  assert.match(row, /justify-content: start;/);
}));

test('Lauf 2, P2: das Naechste und der gewaehlte Block sehen verschieden aus - Kante innen, Ring aussen, beide neben dem Fokusring', () => {
  const upnext = cssRule('.today-timeline__event--upnext');
  assert.match(upnext, /background: color-mix\(in srgb, var\(--c\) var\(--tint-raised\)/, 'eine Sprosse mehr Toenung');
  assert.match(upnext, /border-inline-start: 2px solid var\(--c\)/, 'die Kante am Blockanfang');
  const chosen = cssRule('.today-timeline__event[aria-expanded="true"]');
  assert.ok(!/inset/.test(chosen), 'der Ring der Auswahl liegt aussen');
  assert.match(chosen, /box-shadow: 0 0 0 2px var\(--color-surface\), 0 0 0 4px var\(--c\)/, 'mit Fuge, im Modulton');
  assert.notEqual(upnext, chosen, 'nicht mehr dieselbe Optik');
  const both = cssRule('.today-timeline__event[aria-expanded="true"]:focus-visible');
  assert.match(both, /box-shadow: 0 0 0 2px var\(--c\)/, 'fokussiert rueckt die Auswahl an die Kante, der Fokusring umschliesst sie');
  const narrow = dashboardCss.slice(dashboardCss.indexOf('@container tl-slot (max-width: 5rem)'));
  assert.match(cssRule('  .today-timeline__title', dashboardCss.indexOf('@container tl-slot (max-width: 5rem)')) ?? narrow.slice(0, 900), /text-overflow: clip;/, 'zweizeilig keine Ellipse je Zeile');
});

test('Re-Kritik D7: gestaucht zeigt ein Block nur seinen Ton, eine Mahlzeit nur ihren Punkt - keine Buchstabenreste, der Titel bleibt im Dokument', () => {
  const tiny = dashboardCss.indexOf('@container tl-slot (max-width: 3rem)');
  assert.ok(tiny > -1, 'eine Schwelle fuer gestauchte Bloecke');
  const title = cssRule('  .today-timeline__title', tiny);
  assert.match(title, /clip: rect\(0, 0, 0, 0\);/, 'der Titel geht aus dem Bild ...');
  assert.ok(!/display: none|visibility: hidden/.test(title), '... aber nicht aus dem zugaenglichen Namen');
  const pointCut = dashboardCss.indexOf('@container tl-slot (max-width: 5.5rem)');
  assert.ok(pointCut > -1, 'eine eigene Schwelle fuer den Typ neben dem Punkt');
  assert.match(cssRule('  .today-timeline__event--point .today-timeline__title', pointCut), /clip: rect\(0, 0, 0, 0\);/);
  assert.match(cssRule('.today-timeline__slot--point'), /container: tl-slot \/ inline-size;/, 'der Punkt-Slot fragt seine Breite wie jeder Block');
});

test('Lauf 2, P2: der Fokus auf einem Block ueberlebt den Neuaufbau in seiner Spur und den Buehnenwechsel ueber Ersatzkandidaten', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const prevCss = globalThis.CSS;
  globalThis.CSS = { escape: (v) => String(v) };
  try {
    const other = {};
    const shell = { querySelectorAll: () => [other, btn] };
    const attrs = { 'data-timeline-event': '16@2026-09-24T19:00' };
    const detailRow = { dataset: { timelineDetail: '16@2026-09-24T19:00' }, querySelector: () => ({ getAttribute: () => '/calendar?open=16' }) };
    const sheet = { querySelectorAll: (sel) => (sel === '[data-timeline-detail]' ? [detailRow] : []) };
    var btn = {
      id: '',
      hasAttribute: (n) => n in attrs,
      getAttribute: (n) => attrs[n] ?? null,
      closest: (sel) => (sel === '#dashboard-shell' ? shell : sel === '.today-cockpit' ? sheet : null),
    };
    assert.deepEqual(dash.focusKeyOf(btn), { selector: '[data-timeline-event="16@2026-09-24T19:00"]', index: 1, preventScroll: true },
      'der zweite Block des Termins fuer zwei - vorher kein Schluessel, der Fokus fiel auf <body>');
    assert.deepEqual(dash.todayFocusFallbacks(btn), [
      { selector: '.today-cockpit__rows [data-route="/calendar?open=16"]', index: 0, preventScroll: true },
      '.today-timeline [data-timeline-event]:not([tabindex="-1"])',
      '#today-cockpit-title',
    ], 'schmal die Zeile mit demselben Ziel, dann der Tab-Stopp der Leiste, zuletzt der Kopf');
    assert.deepEqual(dash.todayFocusFallbacks({ closest: () => null }), [], 'ausserhalb des Blatts keine');
    assert.match(dash.renderTodayCockpit(timelineDay(), []), /<h2 id="today-cockpit-title" tabindex="-1">/, 'der Kopf nimmt den Fokus an');
  } finally {
    globalThis.CSS = prevCss;
  }
}));

test('Lauf 2, P2: der Uebertrag von gestern nennt in der aufgeklappten Zeile sein „bis", keine Spanne', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const day = { ...timelineDay(), upcomingEvents: [...timelineDay().upcomingEvents, ev(17, 'Nachtdienst', '2026-09-23T22:00', '2026-09-24T11:00')] };
  const sheet = dash.renderTodayCockpit(day, []);
  const detail = /data-timeline-detail="17@2026-09-23T22:00"[^>]*>([\s\S]*?)<\/a>/.exec(sheet)?.[1] ?? '';
  assert.match(detail, /today-cockpit-card__time">dashboard\.todayUntil\{[^<]*11:00[^<]*\}</, 'er laeuft seit gestern: „bis 11:00"');
  assert.ok(!detail.includes(' - '), 'kein „bis 11:00 - 11:00"');
}));

// MOBIL VERSCHENKT KEINEN PLATZ FUER CONTENT (Critique 2026-10-26, Lauf 2, D3).
// Gemessen 390x844: Kurzfassung 148px ohne ein Tippziel, „+N weitere" in einem
// eigenen 71-75px-Fussband, Zahnarzt und Team-Call zu einem Balken
// verschmolzen. Die Masse (6px, 44px, ~90-100px) prueft die Sichtpruefung;
// hier stehen Markup, Verdrahtung und die Regeln, die es lesen.
const miniOf = (html) => { const at = html.indexOf('<div class="today-timeline-peek'); return at < 0 ? '' : html.slice(at, html.indexOf('class="today-cockpit__rows', at)); };
const lanesOfMini = (html) => [...miniOf(html).matchAll(/<div class="today-timeline__bars" style="--tl-rows:(\d+)">([\s\S]*?)<\/div>/g)]
  .map((m) => ({ rows: Number(m[1]), bars: [...m[2].matchAll(/<i class="([^"]*)" style="([^"]*)"/g)].map((b) => ({ cls: b[1], style: b[2] })) }));

const lateLanes = () => ({
  upcomingEvents: [
    // Alex: nur Vergangenes - die Spur faellt aus dem Bild.
    ev(51, 'Zahnarzt', '2026-09-24T08:30', '2026-09-24T09:30', { assigned_users: [person(1)] }),
    // Emma: Vergangenes und Kommendes - die Spur bleibt, der Vormittag grau.
    ev(52, 'Schule', '2026-09-24T08:00', '2026-09-24T13:00', { assigned_users: [person(3)] }),
    ev(53, 'Kita abholen', '2026-09-24T15:00', '2026-09-24T15:30', { assigned_users: [person(3)] }),
    // Leo: zwei zur selben Zeit - zwei Teilspuren.
    ev(54, 'Training', '2026-09-24T16:00', '2026-09-24T17:00', { assigned_users: [person(4)] }),
    ev(55, 'Team-Call', '2026-09-24T16:30', '2026-09-24T17:30', { assigned_users: [person(4)] }),
  ],
  urgentTasks: [],
  users: TIMELINE_USERS,
});

for (const stage of ['compact', 'phone']) {
  test(`D3 (${stage}): die Kurzfassung zeigt nur Spuren mit Kommendem, Vergangenes darin grau`, inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
    if (stage === 'phone') onPhone();
    const before = globalThis.__renderAvatarStack;
    globalThis.__renderAvatarStack = (users) => `<span title="${users[0].display_name}"></span>`;
    let sheet;
    try { sheet = dash.renderTodayCockpit(lateLanes(), [], false, { stage }); } finally { globalThis.__renderAvatarStack = before; }
    assert.match(sheet, /today-timeline--mini" aria-hidden="true"/, 'Vorbedingung: die Kurzfassung steht');
    const mini = miniOf(sheet);
    const faces = [...mini.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(faces, ['Emma Johnson', 'Leo Johnson'], 'Alex hat heute nichts mehr vor sich - keine Spur');
    const emma = lanesOfMini(sheet)[0];
    assert.equal(emma.bars.length, 2, 'die Schule bleibt als Balken stehen');
    assert.match(emma.bars[0].cls, /today-timeline__bar--past/, 'grau: sie ist vorbei');
    assert.doesNotMatch(emma.bars[1].cls, /--past/, 'die Kita kommt noch');
  }));
}

test('D3: ueberlappende Termine einer Spur stehen in Teilspuren (item.row), nicht ineinander', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  onPhone();
  const sheet = dash.renderTodayCockpit(lateLanes(), [], false, { stage: 'phone' });
  const [emma, leo] = lanesOfMini(sheet);
  assert.equal(emma.rows, 1, 'Schule und Kita folgen aufeinander - eine Reihe');
  assert.equal(leo.rows, 2, 'Training und Team-Call ueberlappen - zwei Reihen');
  assert.deepEqual(leo.bars.map((b) => /--tl-row:(\d+)/.exec(b.style)?.[1]), ['0', '1'], 'jeder Balken in seiner Reihe');
  // Das Stylesheet liest die Reihe: ohne diese Regel laegen beide wieder uebereinander.
  const bar = cssRule('.today-timeline__bar');
  assert.match(bar, /inset-block-start:\s*calc\(var\(--tl-row, 0\) \* \(var\(--tl-bar\) \+ var\(--tl-bar-gap\)\)\)/);
  assert.match(cssRule('.today-timeline__bars'), /block-size:\s*calc\(var\(--tl-rows\) \* var\(--tl-bar\)/, 'die Spur waechst mit ihren Reihen');
  assert.match(cssRule('.today-timeline--mini'), /--tl-bar:\s*var\(--space-1h\)/, '6px je Balken');
}));

test('D3: hat keine Spur mehr etwas vor sich, entfaellt die Kurzfassung - die Zeilen sprechen', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  onPhone();
  const day = { upcomingEvents: [ev(51, 'Zahnarzt', '2026-09-24T08:30', '2026-09-24T09:30', { assigned_users: [person(1)] })], urgentTasks: [], users: TIMELINE_USERS };
  const sheet = dash.renderTodayCockpit(day, [], false, { stage: 'phone' });
  assert.ok(!sheet.includes('today-timeline'), 'kein Bild aus grauen Balken');
  assert.ok(!sheet.includes('today-timeline-peek'), 'und keine leere Huelle');
  assert.match(sheet, /today-cockpit-card--state/, 'die Zustandszeile spricht');
  // Breit bleibt die Leiste: dort traegt sie den ganzen Tag.
  const wide = dash.renderTodayCockpit(day, [], false, { stage: 'wide' });
  assert.match(wide, /today-timeline__title">Zahnarzt</);
}));

test('D3: mit Verdecktem ist das ganze Bild EIN Tippziel auf dieselbe Region wie „+N weitere"', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const viewer = TIMELINE_USERS[1];
  for (const moreOpen of [false, true]) {
    // Drei Zeilen Deckel: verdeckt sind Abendessen und Termine (D6), gemischt.
    const sheet = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'compact', viewer, moreOpen, cap: 3 });
    assert.match(sheet, /id="today-cockpit-more"/, 'Vorbedingung: die verdeckten Zeilen stehen zum Aufklappen da');
    const hit = /<button type="button" class="today-timeline-peek__hit"([^>]*)><\/button>/.exec(sheet);
    assert.ok(hit, 'ueber dem Bild liegt ein Knopf');
    assert.match(hit[1], /data-today-more data-today-peek/, 'verdrahtet wie „+N weitere"');
    assert.match(hit[1], /aria-controls="today-cockpit-more"/);
    assert.match(hit[1], new RegExp(`aria-expanded="${moreOpen}"`), 'sagt denselben Zustand');
    assert.match(hit[1], /aria-label="dashboard\.todayShowDay"/, 'eigener Name, der Inhalt steht in den Zeilen');
    assert.match(hit[1], /data-peek-target="(?:event|meal):[^"]+"/, 'kennt die Zeile, zu der er danach fuehrt');
    assert.match(sheet, /today-timeline-peek today-timeline-peek--action">\s*<div class="today-timeline today-timeline--mini" aria-hidden="true"/, 'das Bild bleibt Bild');
    assert.ok(sheet.indexOf('today-timeline-peek__hit') < sheet.indexOf('class="today-cockpit__rows'), 'das Bild steht ueber den Zeilen');
  }
  // Fuehrt „+N weitere" in eine Ansicht, ist das Bild ein Link dorthin.
  const linked = dash.renderTodayCockpit({ ...busyAfternoon(), todayMeals: [], myShiftsToday: [] }, [], false, { stage: 'compact', cap: 2 });
  assert.match(linked, /<a href="\/calendar\?date=2026-09-24" class="today-timeline-peek__hit" data-route="\/calendar\?date=2026-09-24" aria-label="dashboard\.todayShowDay"><\/a>/);
}));

test('D3: ohne Verdecktes ist das Bild kein Tippziel - aria-hidden, kein Fokusstopp', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  onPhone();
  const sheet = dash.renderTodayCockpit(lateLanes(), [], false, { stage: 'phone', cap: 8 });
  assert.ok(!sheet.includes('today-cockpit__more'), 'Vorbedingung: alles steht, nichts ist verdeckt');
  assert.match(sheet, /<div class="today-timeline-peek">\s*<div class="today-timeline today-timeline--mini" aria-hidden="true"/);
  assert.ok(!sheet.includes('today-timeline-peek__hit'), 'kein Knopf ohne Ziel');
}));

test('D3: der Tipp aufs Bild klappt auf, beide Knoepfe sagen es, und der Fokus geht zur ersten kommenden verdeckten Zeile', () => {
  const region = {
    hidden: true,
    query: [],
    querySelector(sel) {
      this.query.push(sel);
      if (sel === '[data-object-kind="meal"][data-object-id="63"]') return target;
      return sel === 'a[href], button' ? first : null;
    },
  };
  const calls = [];
  const target = { focus: (opts) => calls.push(['focus', opts]), scrollIntoView: (opts) => calls.push(['scroll', opts]) };
  // Die erste Zeile der Region: Ersatzziel, falls die Zielzeile fehlt - und Falle fuer einen Fokussprung von „+N weitere".
  const first = { focus: () => calls.push(['focus-first']), scrollIntoView: () => calls.push(['scroll-first']) };
  const makeToggle = (attrs, dataset, label = null) => {
    const handlers = {};
    return {
      attrs,
      dataset,
      label,
      getAttribute: (name) => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = String(value); },
      querySelector: (sel) => (sel === 'span' ? label : null),
      addEventListener: (type, fn) => { handlers[type] = fn; },
      click() { handlers.click?.(); },
    };
  };
  const peek = makeToggle({ 'aria-expanded': 'false', 'aria-controls': 'today-cockpit-more' }, { todayMore: '', todayPeek: '', peekTarget: 'meal:63' });
  const more = makeToggle({ 'aria-expanded': 'false', 'aria-controls': 'today-cockpit-more' }, { todayMore: '', moreLabel: 'mehr', lessLabel: 'weniger' }, { textContent: 'mehr' });
  const root = {
    querySelectorAll: (sel) => (sel === '[data-today-more]' ? [peek, more] : []),
    querySelector: (sel) => (sel === '#today-cockpit-more' ? region : null),
  };
  const prevWindow = global.window;
  global.window = { matchMedia: () => ({ matches: false }) };
  try {
    dash.wireTodayMore(root);
    peek.click();
    assert.equal(region.hidden, false, 'die Region steht offen');
    assert.equal(peek.attrs['aria-expanded'], 'true');
    assert.equal(more.attrs['aria-expanded'], 'true', '„+N weitere" sagt denselben Zustand');
    assert.equal(more.label.textContent, 'weniger', 'und heisst jetzt „Weniger anzeigen"');
    assert.deepEqual(calls, [['focus', { preventScroll: true }], ['scroll', { block: 'nearest', behavior: 'smooth' }]],
      'Fokus auf die Zielzeile, Blick dorthin - ueber der Kapsel (scroll-padding)');
    calls.length = 0;
    more.click();
    assert.equal(region.hidden, true, '„+N weitere" klappt zu');
    assert.equal(peek.attrs['aria-expanded'], 'false', 'das Bild sagt es mit');
    more.click();
    assert.equal(region.hidden, false);
    assert.deepEqual(calls, [], '„+N weitere" behaelt den Fokus');
  } finally {
    global.window = prevWindow;
  }
});

test('D3: das Ziel nach dem Aufklappen ist die erste kommende verdeckte Zeile', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const now = new Date();
  const hidden = [
    { kind: 'task', objectId: 7, sortKey: '00:00' },
    { kind: 'event', objectId: 43, sortKey: '00:00' },
    { kind: 'meal', objectId: 63, sortKey: '18:30' },
    { kind: 'event', objectId: 45, sortKey: '20:00' },
  ];
  assert.equal(dash.todayPeekTarget(hidden, now), 'meal:63', 'das Abendessen um 18:30 - nicht die Aufgabe, nicht das Ganztaegige');
  assert.equal(dash.todayPeekTarget(hidden.slice(0, 2), now), 'task:7', 'ohne Kommendes die erste verdeckte Zeile');
}));

for (const stage of ['compact', 'phone']) {
  test(`D3 (${stage}): „+N weitere" ist die letzte Zeile der Liste statt eines Fussbands`, inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
    if (stage === 'phone') onPhone();
    const viewer = TIMELINE_USERS[1];
    const sheet = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage, viewer, cap: 2 });
    const more = /<(a|button)\b[^>]*class="today-cockpit__more today-cockpit__more--link today-cockpit__more--row"/.exec(sheet);
    assert.ok(more, '„+N weitere" steht als Zeile im Raster der Zeilen');
    assert.ok(!sheet.includes('today-cockpit__foot'), 'kein Fussband, das nur den Link traegt');
    assert.ok(sheet.indexOf(more[0]) > sheet.lastIndexOf('today-cockpit-card__value'), 'nach der letzten Zeile');
    // Die Coda behaelt ihren Fuss.
    const quiet = dash.renderTodayCockpit({ upcomingEvents: [ev(53, 'Kita abholen', '2026-09-24T15:00', '2026-09-24T15:30', { assigned_users: [person(3)] })], urgentTasks: [], users: TIMELINE_USERS }, [], false, { stage, cap: 8 });
    assert.match(quiet, /<div class="today-cockpit__foot"><span class="today-cockpit__coda">[^<]+<\/span><\/div>/);
  }));
}

test('D3: breit bleibt „+N weitere" rechts im Fuss; die Zeile hat Zielhoehe und die Titelkante', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const tasks = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, due_date: '2026-09-24',
    due_time: `${String(15 + (i % 6)).padStart(2, '0')}:00`, status: 'open', assigned_users: [] }));
  const sheet = dash.renderTodayCockpit({ urgentTasks: tasks, users: [] }, [], false, { stage: 'wide' });
  assert.match(sheet, /<div class="today-cockpit__foot">\s*<a href="\/tasks\?due=today" class="today-cockpit__more today-cockpit__more--link" data-route=/, 'breit unveraendert im Fuss');
  assert.ok(!sheet.includes('today-cockpit__more--row'));
  const row = cssRule('.today-cockpit__more--row');
  assert.match(row, /min-height:\s*var\(--target-base\)/, '44px Ziel');
  assert.match(row, /grid-template-columns:\s*calc\(var\(--target-sm\) \+ var\(--space-5\) - var\(--space-2\)\) minmax\(0, 1fr\) auto/, 'dasselbe Raster wie die Zeilen');
  assert.match(cssRule('.today-cockpit__more--row > span'), /grid-column:\s*2/, 'der Text an der Titelkante');
  const hit = cssRule('.today-timeline-peek--action');
  assert.match(hit, /min-block-size:\s*var\(--target-base\)/, 'das Bild ist mindestens ein 44px-Ziel');
  assert.match(cssRule('.today-timeline-peek__hit:focus-visible'), /outline-offset:\s*var\(--focus-ring-offset-inset\)/, 'sichtbarer Fokus innen');
}));


// DER KOPF ZAEHLT, WAS NOCH KOMMT - AUF JEDER BUEHNE (Ulas, 2026-10-26, D5).
// Breit hiess es „5 Termine" samt Vergangenem, darunter „4 Termine": dieselbe
// Familie, derselbe Moment, zwei Zahlen. Jetzt eine Quelle und ein Satz.
const summaryOf = (html) => /today-cockpit__summary">([^<]*)</.exec(html)?.[1] ?? '';

test('D5: wide, compact und phone sagen fuer denselben Tag dieselbe Zahl - die der erreichbaren Terminzeilen', inBrowser(THU_1430_BERLIN, 'Europe/Berlin', () => {
  const viewer = TIMELINE_USERS[1];
  const wide = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'wide', viewer, moreOpen: true });
  const compact = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'compact', viewer, moreOpen: true });
  onPhone();
  const phone = dash.renderTodayCockpit(busyAfternoon(), [], false, { stage: 'phone', viewer, moreOpen: true });
  assert.equal(/data-today-stage="([^"]+)"/.exec(phone)?.[1], 'phone', 'Vorbedingung: die Telefon-Buehne');
  assert.equal(summaryEvents(wide), 4, 'Kita, Elternabend, Ausflug, Filmabend - der Zahnarzt ist vorbei');
  assert.equal(summaryEvents(compact), summaryEvents(wide), 'compact zaehlt wie breit');
  assert.equal(summaryEvents(phone), summaryEvents(wide), 'das Telefon zaehlt wie breit');
  // Seit D6 fuehren die Termine; was der Deckel verdeckt, sind nur Termine und
  // steht am Kalendertag hinter „+N weitere".
  const atCalendar = Number(/<a href="\/calendar\?date=2026-09-24" class="today-cockpit__more[\s\S]*?todayMore\{&quot;count&quot;:(\d+)\}/.exec(compact)?.[1] ?? 0);
  assert.equal(summaryEvents(compact), eventRowIds(reachableText(compact)).length + atCalendar, 'und die Zahl ist die der lesbaren Terminzeilen samt denen am Kalendertag');
}));

test('D5: endet ein Termin, faellt er aus der Zahl, und der Minutentakt baut neu', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  // Der Fussball endet um 17:30 (15:30Z). Er steht nur in der Familienliste,
  // also in keiner Zeile, die der Stempel ohnehin vergleicht.
  const before = new Date('2026-09-24T15:29:00Z');
  const after = new Date('2026-09-24T15:31:00Z');
  for (const stage of ['wide', 'compact']) {
    assert.equal(summaryEvents(dash.renderTodayCockpit(timelineDay(), [], false, { stage, now: before })), 3, `${stage}: Fussball laeuft noch und zaehlt`);
    assert.equal(summaryEvents(dash.renderTodayCockpit(timelineDay(), [], false, { stage, now: after })), 2, `${stage}: Fussball ist vorbei`);
  }
  assert.notEqual(dash.todayFingerprint(timelineDay(), [], before), dash.todayFingerprint(timelineDay(), [], after),
    'das Ende aendert den Stempel - sonst stuende die alte Zahl bis zum naechsten Anlass');
}));

test('D5: ist kein Termin mehr uebrig, entfaellt der Termin-Teil - das Ueberfaellige bleibt', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const day = { ...timelineDay(), upcomingEvents: timelineDay().upcomingEvents.filter((event) => !event.all_day) };
  const late = new Date('2026-09-24T20:30:00Z'); // 22:30, der Filmabend endete um 22:00
  for (const stage of ['wide', 'compact']) {
    const sheet = dash.renderTodayCockpit(day, [], false, { stage, now: late });
    assert.ok(!sheet.includes('todaySummaryEventsAhead'), `${stage}: kein „noch 0 Termine"`);
    assert.equal(summaryOf(sheet), 'dashboard.todaySummaryOverdue{&quot;count&quot;:1}', `${stage}: nur das Ueberfaellige`);
  }
  // Das Ganztaegige ist bis Mitternacht nicht vorbei.
  const withAllDay = dash.renderTodayCockpit(timelineDay(), [], false, { stage: 'wide', now: late });
  assert.equal(summaryEvents(withAllDay), 1, 'der Ausflug zaehlt bis zum Tagesende');
}));

test('D5: „noch N Termine" steht mit allen Pluralformen in jeder Sprache, der alte Schluessel nirgends', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const extra = { cs: ['few', 'many'], pl: ['few', 'many'], ru: ['few', 'many'], uk: ['few', 'many'], ar: ['two', 'few', 'many'] };
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 27);
  for (const name of files) {
    const lang = name.replace(/\.json$/, '');
    const dashboard = JSON.parse(readFileSync(new URL(name, dir), 'utf8')).dashboard ?? {};
    for (const suffix of ['', '_one', ...(extra[lang] ?? []).map((form) => `_${form}`)]) {
      const value = dashboard[`todaySummaryEventsAhead${suffix}`];
      assert.ok(typeof value === 'string' && value.includes('{{count}}'), `${lang}: todaySummaryEventsAhead${suffix}`);
    }
    assert.ok(!Object.keys(dashboard).some((key) => /^todaySummaryEvents(_|$)/.test(key)), `${lang}: der alte Schluessel ist weg`);
  }
});


// DIE GLIEDERUNG WIE BREIT (Critique 2026-10-26, Lauf 2, D6). Gemessen bei
// 390x844 um 16:30: sichtbar Abendessen, Sportfest und drei Aufgaben; der
// laufende Fussball, Elternabend und Filmabend standen hinter „+6 weitere",
// dort sogar nach Medikament und Haushaltshilfe - unter „noch 4 Termine".
// Jetzt fuehren die Eintraege der Leiste (chronologisch, Ganztaegiges vorn,
// Laufendes sagt es), danach „Ausserdem heute" mit dem Rest; der Deckel
// kuerzt zuerst den Rest.
const THU_1630_BERLIN = '2026-09-24T14:30:00Z';
const rushHour = (extra = {}) => ({
  upcomingEvents: [
    ev(51, 'Sportfest', '2026-09-24', '2026-09-24', { all_day: 1 }),
    ev(52, 'Fussball', '2026-09-24T16:00', '2026-09-24T17:30', { assigned_users: [person(4)] }),
    ev(53, 'Elternabend', '2026-09-24T19:00', '2026-09-24T20:30', { assigned_users: [person(1), person(2)] }),
    ev(54, 'Filmabend', '2026-09-24T20:00', '2026-09-24T22:00'),
  ],
  familyEvents: [ev(55, 'Zahnarzt', '2026-09-24T08:30', '2026-09-24T09:30', { assigned_users: [person(1)] })],
  todayMeals: [{ id: 63, meal_type: 'dinner', title: 'Ofengemuese' }],
  urgentTasks: [
    { id: 21, title: 'Stromrechnung', due_date: '2026-09-22', status: 'open', assigned_users: [] },
    { id: 22, title: 'Formular', due_date: '2026-09-24', status: 'open', assigned_users: [] },
    { id: 23, title: 'Pfand', due_date: '2026-09-24', due_time: '18:00', status: 'open', assigned_users: [] },
  ],
  health: { dosesTotal: 1, dosesTaken: 0, nextDose: { name: 'Eisen', time: '18:00' } },
  users: TIMELINE_USERS,
  ...extra,
});
const LEAD_TITLES = ['Sportfest', 'Fussball', 'Ofengemuese', 'Elternabend', 'Filmabend'];
const ALSO_ROW = '<h3 class="today-cockpit__also today-cockpit__also--row">dashboard.todayAlsoTitle</h3>';
/** Zeilentitel und Ueberschrift in der Reihenfolge des Markups (ab den Zeilen). */
const sheetOrder = (html) => [...reachableText(html).matchAll(/today-cockpit-card__value">([^<]*)<|(today-cockpit__also--row)/g)]
  .map((m) => m[1] ?? 'ALSO');
const shownPart = (html) => (html.includes('id="today-cockpit-more"') ? html.slice(0, html.indexOf('id="today-cockpit-more"')) : html);

for (const stage of ['compact', 'phone']) {
  test(`D6 (${stage}): erst die Leiste chronologisch, Ganztaegiges vorn, dann „Ausserdem heute" mit dem Rest`, inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
    if (stage === 'phone') onPhone();
    const sheet = dash.renderTodayCockpit(rushHour(), [], false, { stage, cap: 12 });
    assert.equal(/data-today-stage="([^"]+)"/.exec(sheet)?.[1], stage, 'Vorbedingung: die Buehne');
    const order = sheetOrder(sheet);
    const also = order.indexOf('ALSO');
    assert.deepEqual(order.slice(0, also), LEAD_TITLES, 'Teil 1: Ganztaegiges, dann nach Uhrzeit - samt laufendem Fussball');
    assert.equal(order.filter((entry) => entry === 'ALSO').length, 1, 'eine Ueberschrift');
    const rest = order.slice(also + 1);
    for (const title of ['Stromrechnung', 'Formular', 'Pfand', 'Eisen']) assert.ok(rest.includes(title), `${title} steht unter „Ausserdem heute"`);
    assert.equal(rest.length, 4, 'nichts aus der Leiste im Rest');
    assert.ok(sheet.includes(ALSO_ROW), 'eine Ueberschrift (h3 unter dem h2 des Blatts), die der Screenreader hoert');
  }));
}

test('D6: ein laufender Termin sagt „laeuft gerade" im Modulton statt seines Beginns; breit bleibt er Block', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'compact', cap: 12 });
  const row = /today-cockpit-card__value">Fussball<[\s\S]*?<span class="(today-cockpit-card__time[^"]*)">([^<]*)</.exec(sheet);
  assert.ok(row, 'der Fussball hat eine Zeit');
  assert.equal(row[2], 'dashboard.todayTimelineRunning', 'nicht „16:00", sondern dass er laeuft');
  assert.match(row[1], /today-cockpit-card__time--soon/, 'im Ton des Moduls, wie „in 25 Min"');
  const elternabend = /today-cockpit-card__value">Elternabend<[\s\S]*?today-cockpit-card__time[^"]*">([^<]*)</.exec(sheet)?.[1];
  assert.match(elternabend, /^19:00 · /, 'der kommende behaelt Uhrzeit und Abstand');
  assert.match(sheet, /today-cockpit-card__value">Sportfest<[\s\S]*?today-cockpit-card__time">dashboard\.allDay</, 'das Ganztaegige sagt „ganztaegig"');
  const wide = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'wide' });
  assert.ok(!reachableText(wide).includes('Fussball'), 'breit steht er nur in der Leiste');
}));

test('D6: der Deckel kuerzt zuerst den Rest, dann die Leiste von hinten - „+N weitere" bleibt die letzte Zeile', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  // compact (Deckel 4): nur Leiste sichtbar, der Rest beginnt in den aufgeklappten Zeilen.
  const compact = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'compact', moreOpen: false });
  assert.deepEqual(sheetOrder(shownPart(compact)), LEAD_TITLES.slice(0, 4), 'die Leiste fuellt den Deckel');
  const more = /id="today-cockpit-more" hidden>([\s\S]*?)<\/div><button type="button" class="today-cockpit__more/.exec(compact);
  assert.ok(more, 'der Rest steht zum Aufklappen da, „+N weitere" folgt als letzte Zeile');
  assert.ok(more[1].indexOf('Filmabend') < more[1].indexOf(ALSO_ROW), 'aufgeklappt: erst der Rest der Leiste, dann die Ueberschrift');
  assert.match(compact, /dashboard\.todayMore\{&quot;count&quot;:5\}/, 'Filmabend und vier aus dem Rest');
  assert.match(compact, /today-cockpit__more--row[\s\S]*?<\/button>\s*<\/div>\s*<\/section>/, 'nichts unter „+N weitere"');
  // Deckel 6: die ganze Leiste und EINE Zeile des Rests - die offene mit dem hoechsten Rang.
  const six = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'compact', cap: 6, moreOpen: false });
  const shown = sheetOrder(shownPart(six));
  assert.deepEqual(shown.slice(0, 6), [...LEAD_TITLES, 'ALSO']);
  assert.equal(shown.length, 7, 'eine Zeile des Rests');
  assert.equal((six.match(/today-cockpit__also--row/g) ?? []).length, 1, 'auch aufgeklappt nur einmal');
  // Telefon (Deckel 2): Ganztaegiges und Laufendes, sonst nichts.
  onPhone();
  const phone = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'phone', moreOpen: false });
  assert.deepEqual(sheetOrder(shownPart(phone)), ['Sportfest', 'Fussball']);
}));

test('D6: der Deckel haelt den ersten Eintrag mit Uhrzeit, auch wenn Ganztaegiges ihn fuellt (der Kopf ist belegt)', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  onPhone();
  const crowded = rushHour();
  crowded.upcomingEvents.push(ev(56, 'Ferien', '2026-09-24', '2026-09-24', { all_day: 1 }), ev(57, 'Messe', '2026-09-24', '2026-09-24', { all_day: 1 }));
  const phone = dash.renderTodayCockpit(crowded, [], false, { stage: 'phone', moreOpen: false });
  const shown = sheetOrder(shownPart(phone));
  assert.equal(shown.length, 2, 'Vorbedingung: zwei Zeilen Deckel');
  assert.equal(shown[1], 'Fussball', 'was gerade laeuft, steht - nach dem ersten Ganztaegigen');
  assert.ok(summaryEvents(phone) > 0 && eventRowIds(shownPart(phone).slice(phone.indexOf('class="today-cockpit__rows'))).length >= 1, '„noch N Termine" hat sichtbare Termine');
  // Ohne Laufendes ist es das Naechste.
  const later = dash.renderTodayCockpit(crowded, [], false, { stage: 'phone', moreOpen: false, now: new Date('2026-09-24T15:45:00Z') });
  assert.equal(sheetOrder(shownPart(later))[1], 'Ofengemuese', 'um 17:45 ist das Abendessen das Naechste');
}));

test('D6: die Ueberschrift nur zwischen zwei Teilen - vor der Einkaufszeile, wenn sie allein den Rest bildet', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const onlyTimeline = dash.renderTodayCockpit(rushHour({ urgentTasks: [], health: null }), [], false, { stage: 'compact', cap: 12 });
  assert.ok(!onlyTimeline.includes('today-cockpit__also'), 'ohne Rest keine Ueberschrift');
  const onlyRest = dash.renderTodayCockpit(rushHour({ upcomingEvents: [], familyEvents: [], todayMeals: [] }), [], false, { stage: 'compact', cap: 12 });
  assert.match(onlyRest, /Stromrechnung/, 'Vorbedingung: der Rest steht');
  assert.ok(!onlyRest.includes('today-cockpit__also'), 'ohne Leiste keine Ueberschrift');
  const shopping = dash.renderTodayCockpit(rushHour({ urgentTasks: [], health: null, shoppingOpenCount: 3 }), [], false, { stage: 'compact', cap: 12 });
  assert.match(shopping, new RegExp(`today-cockpit-card__value">Filmabend<[\\s\\S]*?</div>${ALSO_ROW.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<a [^>]*today-cockpit-card--shopping`), 'die Einkaufszeile ist der Rest');
  // Das Stylesheet: Vorderkante der Zeilen, Luft darueber, keine doppelte Linie am Aufklapp-Rand.
  const row = cssRule('.today-cockpit__also--row');
  assert.match(row, /margin:\s*0;/);
  assert.match(row, /padding:\s*var\(--space-4\) var\(--space-4\) 0;/);
  assert.match(cssRule('.today-cockpit__rows--more > .today-cockpit__also--row:first-child'), /border-top:\s*none/);
}));

// R24 (Uebergabe S1 zu G1-Uebersicht-P2-1): die Wand deckelte „offen zuerst"
// ohne Leiste - dieselben Daten zeigten bei 1440 das Sportfest, bei 1024 nicht,
// und offene Aufgaben drueckten die Termine des Abends hinaus. Sie rechnet jetzt
// wie das Cockpit unter der breiten Buehne: erst die Leiste (Ganztaegiges vorn,
// dann nach Uhrzeit), der Deckel kuerzt zuerst den Rest.
test('R24: die Wand fuehrt mit der Leiste, wie das Cockpit', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const html = dash.renderWallSurface(rushHour(), null, { now: new Date() });
  const titles = [...html.matchAll(/wall-row__title">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(titles.slice(0, 4), LEAD_TITLES.slice(0, 4), `Ganztaegiges, dann nach Uhrzeit: ${titles}`);
  assert.ok(!titles.includes('Stromrechnung'), 'eine offene Aufgabe verdraengt keinen Termin des Tages');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/buildTodayCockpitModel\(data, \[\], \{[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3 && calls.every((call) => call.includes('...wallTimelineOptions(data, now)')),
    `jeder Aufruf der Wand rechnet mit der Leiste (Deckel, Leiter, Abgabe): ${calls.length}`);
}));

test('D6: breit bleibt alles, wie es war - keine Teile, keine zweite Ueberschrift', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const wide = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'wide' });
  assert.ok(!wide.includes('today-cockpit__also--row'), 'die Zeilen-Ueberschrift gibt es nur darunter');
  assert.match(wide, /<p class="today-cockpit__also">dashboard\.todayAlsoTitle<\/p>/, 'der Streifen heisst weiter „Ausserdem heute"');
  assert.ok(!wide.includes('data-program-lead'));
  const model = dash.buildTodayCockpitModel(rushHour(), [], { cap: 3, timeline: dash.buildTodayTimeline(rushHour(), { includeMeals: true }) });
  assert.equal(model.lead, null, 'breit kein Teil 1');
  assert.deepEqual(model.rows.map((row) => row.title), ['Stromrechnung', 'Formular', 'Eisen'], 'Offenes bleibt, gezeigt nach dem Tag - wie bisher');
}));

test('D6: der Telefon-Fit rechnet die Ueberschrift mit, sobald der Deckel ueber die Leiste reicht', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const day = { fold: 740, rowsTop: 226, rowHeight: 64, trailing: 44, total: 9, lead: 5, divider: 32 };
  assert.equal(dash.programRowsThatFit({ ...day, divider: 0 }), 7, 'Vorbedingung: ohne Ueberschrift sieben Zeilen');
  assert.equal(dash.programRowsThatFit(day), 6, 'die Ueberschrift kostet eine Zeile');
  assert.equal(dash.programRowsThatFit({ ...day, lead: 8 }), 7, 'reicht der Deckel nicht ueber die Leiste, steht keine');
  assert.equal(dash.programRowsThatFit({ ...day, total: 7, rest: 0 }), 7, 'alles passt samt Ueberschrift');
  assert.equal(dash.programRowsThatFit({ ...day, total: 7, rest: 44 }), 6, 'mit Einkaufszeile nicht mehr');
  assert.equal(dash.programRowsThatFit({ ...day, total: 7, rest: 44, divider: 0 }), 7, 'ohne Ueberschrift haette es gepasst');
  // Verdrahtet: das Blatt nennt die Zahl der Leiste, die Messung reicht sie samt Hoehe weiter.
  onPhone();
  assert.match(dash.renderTodayCockpit(rushHour(), [], false, { stage: 'phone' }), /data-program-lead="5"/);
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const measure = src.slice(src.indexOf('function measurePhoneProgram'), src.indexOf('function refitTodayStage'));
  assert.match(measure, /section\.dataset\.programLead/);
  assert.match(measure, /\.today-cockpit__also--row/);
  assert.match(measure, /const geometry = \{[\s\S]*?\blead,\s*divider,\s*\};/);
}));

// DIE GEWICHTETE ACHSE (Ulas, 2026-10-26, D7). Gemessen bei 1440 (Spur 976px,
// Achse 06-22): eine Stunde 61px, um 16:26 gehoerten gut 60 % der Achse dem
// Vergangenen, das Kommende war abgeschnitten. Jetzt bis zum Knie (volle
// Stunde von jetzt - 1 h) hoechstens ein Drittel, danach volle Breite; alle
// Teile der Leiste lesen dieselbe Abbildung, die Kurzfassung bleibt linear.
const { timelineScale: d7Scale, TIMELINE_PAST_SHARE: D7_SHARE } = await import('../public/utils/today-timeline.js');
/** 16:30 auf der Achse 07-22 des rushHour-Tages: Knie 15:00. */
const D7_AXIS = { start: 420, end: 1320, knee: 900 };
const d7Close = (actual, expected, message) => assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message}: ${actual} statt ${expected}`);
const styleVar = (attrs, name) => new RegExp(`${name}:([^;"]+)`).exec(attrs)?.[1];

test('D7: breit stehen Bloecke, Strich, Fahne, Stunden und Gitter auf derselben gewichteten Achse', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'wide' });
  const timeline = timelineOf(sheet);
  const scale = d7Scale(D7_AXIS);
  const root = /<div class="today-timeline"[^>]*>/.exec(timeline)?.[0] ?? '';
  assert.match(root, /data-timeline-knee="900"/, 'das Knie steht am Element - der Minutentakt liest es');
  assert.ok(!/--tl-hours/.test(root), 'kein Hintergrund in gleichen Schritten mehr');
  d7Close(styleVar(root, '--tl-now'), scale.x(990), 'der Jetzt-Strich');
  d7Close(scale.x(900), D7_SHARE, 'Vorbedingung: das Vergangene bis 15:00 auf einem Drittel');
  const slots = [...timeline.matchAll(/<li class="today-timeline__slot[^"]*" data-timeline-at="(\d+)" style="([^"]*)"/g)];
  assert.ok(slots.length >= 5, 'Vorbedingung: die Bloecke des Tages');
  for (const [, start, style] of slots) d7Close(styleVar(style, '--tl-left'), scale.x(Number(start)), `Block um ${start}`);
  // Der Elternabend 19:00-20:30 in zwei Spuren: bei 976px Spur 139px statt 91px.
  const parents = slots.filter(([, start]) => start === '1140');
  assert.equal(parents.length, 2);
  d7Close(styleVar(parents[0][2], '--tl-width'), scale.width(1140, 1230), 'Breite ueber dieselbe Abbildung');
  assert.ok(scale.width(1140, 1230) * 976 > 135, 'das Kommende ist breiter als linear (91px)');
  const flag = /<span class="today-timeline__flag"([^>]*)>/.exec(timeline)?.[1] ?? '';
  const nextSlot = slots.find(([, start]) => flag.includes(`data-flag-at="${start}"`));
  assert.ok(nextSlot, 'Vorbedingung: die Fahne gehoert zu einem Block');
  assert.equal(styleVar(flag, '--tl-at'), styleVar(nextSlot[2], '--tl-left'), 'die Fahne ueber dem Blockanfang');
  const hours = [...timeline.matchAll(/<span class="(today-timeline__hour[^"]*)" data-minute="(\d+)" style="--tl-at:([^"]+)">/g)];
  assert.equal(hours.length, 15);
  for (const [, , minute, x] of hours) d7Close(x, scale.x(Number(minute)), `Stunde ${minute}`);
  const sparse = hours.filter(([, cls]) => cls.includes('--sparse')).map(([, , minute]) => Number(minute) / 60);
  assert.deepEqual(sparse, [8, 10, 12, 14], 'vor dem Knie spricht jede zweite Stunde, vom Knie aus gezaehlt');
  assert.ok(!hours.some(([cls, , minute]) => cls.includes('--covered') && Number(minute) === 1020), 'die 17 neben 16:30 spricht wieder');
  const grid = /<div class="today-timeline__grid" aria-hidden="true">([\s\S]*?)<\/div>/.exec(timeline)?.[1] ?? '';
  const lines = [...grid.matchAll(/--tl-at:([^"]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(lines, hours.map(([, , , x]) => Number(x)), 'eine Linie je Stunde, auch vor dem Knie');
  // Und das Stylesheet zeichnet die Linien aus der Ebene, nicht aus einem Hintergrund in gleichen Schritten.
  assert.ok(!/background-size:\s*calc\(100% \/ var\(--tl-hours/.test(dashboardCss));
  const line = cssRule('.today-timeline__grid > span') ?? '';
  assert.match(line, /inset-inline-start: calc\(var\(--tl-at\) \* 100%\)/);
  assert.match(line, /inline-size: 1px;[\s\S]*background: var\(--color-border-subtle\)/, 'eine feine Linie in der Farbe der Haarlinie');
  assert.match(cssRule('.today-timeline__grid') ?? '', /pointer-events: none/);
  assert.match(cssRule('.today-timeline__hour--sparse') ?? '', /visibility: hidden/);
}));

test('D7: frueh am Tag bleibt die breite Achse linear - die Vergangenheit ist schmaler als ein Drittel', inBrowser(THU_10_BERLIN, 'Europe/Berlin', () => {
  const timeline = timelineOf(dash.renderTodayCockpit(timelineDay(), []));
  assert.ok(!/data-timeline-knee/.test(timeline), 'um 10:00 auf 07-22 kein Knie');
  assert.ok(!timeline.includes('today-timeline__hour--sparse'));
  const slot = /data-timeline-at="1215" style="--tl-left:([^;]+);/.exec(timeline);
  d7Close(slot?.[1], (1215 - 420) / 900, 'der Filmabend linear');
}));

test('D7: jeder Leistenblock traegt seinen vollen Titel samt Beginn als title, durch esc()', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const day = rushHour();
  day.upcomingEvents.push(ev(56, 'Tom & "Jerry" <3', '2026-09-24T21:00', '2026-09-24T21:45'));
  const timeline = timelineOf(dash.renderTodayCockpit(day, [], false, { stage: 'wide' }));
  const buttons = [...timeline.matchAll(/<button type="button" class="today-timeline__event[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 7, 'Vorbedingung: Bloecke und Band');
  assert.ok(buttons.every((button) => / title="[^"]+"/.test(button)), 'jeder Block hat einen title');
  // formatTime reicht im Stub den Zeitstempel durch.
  assert.ok(buttons.some((button) => button.includes('title="Elternabend · 2026-09-24T19:00"')), 'Titel und Beginn');
  assert.ok(buttons.some((button) => button.includes('title="Tom &amp; &quot;Jerry&quot; &lt;3 · 2026-09-24T21:00"')), 'Nutzerdaten laufen durch esc()');
  assert.ok(buttons.some((button) => button.includes('title="Sportfest"')), 'Ganztaegiges ohne Zeit');
  assert.ok(!buttons.some((button) => /title="[^"]*2026-09-24T20:30/.test(button)), 'nur der Beginn, wie im ganzen Blatt (#1698)');
  // Der zugaengliche Name bleibt der Inhalt des Knopfs.
  assert.match(timeline, /<span class="sr-only">dashboard\.todayTimelineEveryone: <\/span><span class="today-timeline__title">Tom &amp; &quot;Jerry&quot; &lt;3<\/span>/);
}));

test('D7: die Kurzfassung bleibt linear, auch wenn die breite Leiste gestaucht waere', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const sheet = dash.renderTodayCockpit(rushHour(), [], false, { stage: 'compact' });
  const root = /<div class="today-timeline today-timeline--mini[^>]*>/.exec(sheet)?.[0] ?? '';
  assert.ok(root, 'Vorbedingung: die Kurzfassung steht');
  assert.ok(!root.includes('data-timeline-knee'), 'kein Knie - der Minutentakt rechnet linear');
  d7Close(styleVar(root, '--tl-now'), (990 - 420) / 900, 'der Strich linear');
  const timeline = dash.buildTodayTimeline(rushHour(), { includeMeals: true, includeShifts: true });
  assert.equal(timeline.knee, 900, 'Vorbedingung: das Modell traegt ein Knie');
  const bars = [...sheet.matchAll(/<i class="today-timeline__bar[^"]*" style="--tl-left:([^;]+);--tl-width:([^;]+);/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const expected = timeline.lanes.filter((lane) => lane.items.some((item) => item.state !== 'past'))
    .flatMap((lane) => lane.items).map((item) => [(item.start - 420) / 900, (item.end - item.start) / 900]);
  assert.equal(bars.length, expected.length);
  bars.forEach(([left, width], index) => {
    d7Close(left, expected[index][0], `Balken ${index}`);
    d7Close(width, expected[index][1], `Balken ${index} Breite`);
  });
}));

test('D7: der Minutentakt fuehrt den Strich ueber das gezeichnete Knie, die Kurzfassung linear', () => {
  const fake = (dataset) => {
    const style = new Map();
    const hours = [1020, 1080].map((minute) => {
      const classes = new Set();
      return { dataset: { minute: String(minute) }, classes, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
    });
    const timeline = {
      dataset,
      style: { setProperty: (k, v) => style.set(k, v) },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.today-timeline__hour[data-minute]' ? hours : []),
    };
    return { root: { querySelector: (sel) => (sel === '.today-timeline' ? timeline : null) }, style, hours };
  };
  return inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
    const wide = fake({ timelineStart: '420', timelineEnd: '1320', timelineKnee: '900' });
    dash.updateTodayTimelineNow(wide.root, new Date('2026-09-24T14:45:00Z'));
    d7Close(wide.style.get('--tl-now'), d7Scale(D7_AXIS).x(1005), 'um 16:45 auf der gewichteten Achse');
    assert.deepEqual(wide.hours.map((h) => h.classes.has('today-timeline__hour--covered')), [true, false], 'die 17 unter der Pille, die 18 nicht');
    // Baut die Uebersicht um 17:05 nicht neu (Anpassen-Modus), bleibt der Strich auf der gezeichneten Achse.
    dash.updateTodayTimelineNow(wide.root, new Date('2026-09-24T15:05:00Z'));
    d7Close(wide.style.get('--tl-now'), d7Scale(D7_AXIS).x(1025), 'das Knie des Markups, nicht das der Uhr');
    const mini = fake({ timelineStart: '420', timelineEnd: '1320' });
    dash.updateTodayTimelineNow(mini.root, new Date('2026-09-24T14:45:00Z'));
    d7Close(mini.style.get('--tl-now'), (1005 - 420) / 900, 'ohne Knie linear');
  })();
});

test('D7: das Knie springt nur zur vollen Stunde - dann baut der Minutentakt neu, dazwischen nicht', inBrowser(THU_1630_BERLIN, 'Europe/Berlin', () => {
  const at = (clock) => dash.todayFingerprint(rushHour(), [], new Date(`2026-09-24T${clock}:00Z`));
  assert.equal(at('14:05'), at('14:30'), 'zwischen 16:05 und 16:30 bleibt die Geometrie');
  assert.equal(at('14:30'), at('14:59'), 'bis 16:59');
  const before = JSON.parse(at('14:59'));
  const after = JSON.parse(at('15:00'));
  assert.notDeepEqual(after, before, 'um 17:00 rueckt das Knie auf 16:00');
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1), 'Vorbedingung: sonst aendert sich um 17:00 nichts');
  assert.deepEqual([before.at(-1), after.at(-1)], [900, 960]);
}));
