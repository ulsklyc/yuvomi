/**
 * Modul: Uebersicht - welche Kalender die Kalender-Kachel zeigt (#2062, aus D#2037)
 * Zweck: Die Kachel kannte "alle / nur meine", Geburtstage an/aus und 5/8/12
 *        Zeilen (#1680), aber keine Auswahl von Kalendern. Seit #2062 bietet
 *        ihr Optionen-Dialog die Kalender des Haushalts (eigene,
 *        synchronisierte, Abos) zur Mehrfachauswahl, nach dem Muster der
 *        Listenwahl der Einkaufs-Kachel (#1818). Geprueft wird der ganze Weg:
 *
 *        1. Route: `events_calendar` schraenkt Liste und Wochenstreifen VOR dem
 *           Deckel ein; Termine ohne Kalender (Geburtstage, ...) bleiben. Ein
 *           ENTFERNTER Kalender - lokal geloescht, Abo entfernt, Konto
 *           getrennt - faellt still aus der Auswahl; bleibt keiner, antwortet
 *           die Route wie ohne Parameter. Ein fremdes privates Abo ist nicht
 *           waehlbar.
 *        2. Katalog: `GET /calendar/calendars` traegt `sources` neben `data`.
 *        3. Ablage: die Auswahl geht durch `PUT /preferences`.
 *        4. Browser: die Anfrage traegt die Auswahl (auch die der Wand), der
 *           Dialog hakt Gespeichertes an, das es noch gibt, speichert nur eine
 *           echte Auswahl und laesst sie bei einem Katalogfehler stehen; die
 *           Kachel und ihr "weitere"-Hinweis folgen der Auswahl.
 *
 * Ausfuehren: npm run test:dashboard-calendar-selection
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
process.env.SESSION_SECRET = 'dashboard-calendar-selection-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { default: localCalendarsRouter } = await import('../server/routes/calendar/local-calendars.js');
const { normalizeCalendarSelection } = await import('../server/services/calendar-selection.js');
const widgets = await import('../public/utils/dashboard-widgets.js');

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

const addUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, ?, 'hash', '#7C3AED', ?, ?)
`);
const ADMIN = Number(addUser.run(`cal-admin-${randomUUID()}`, 'Anna', 'admin', 'parent').lastInsertRowid);
const LEO = Number(addUser.run(`cal-leo-${randomUUID()}`, 'Leo', 'member', 'child').lastInsertRowid);

let currentUser = ADMIN;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUser);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/preferences', preferencesRouter);
app.use('/calendar', localCalendarsRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

// Mittwoch, 28.10.2026, 09:00 in Berlin - jeder Termin der Saat liegt danach.
const NOW = '2026-10-28T08:00:00Z';
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();

async function getJson(path) {
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  try {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path}: ${res.status}`);
    return await res.json();
  } finally {
    mock.timers.reset();
  }
}

// --------------------------------------------------------------------------
// Die Saat: zwei eigene Kalender, ein synchronisierter, ein geteiltes und ein
// privates Abo von Leo - und ein Google-Termin ohne Kalenderzeile (kein
// Schluessel, gehoert keinem Kalender).
// --------------------------------------------------------------------------
const DEFAULT_LOCAL = db.prepare('SELECT id FROM local_calendars WHERE is_default = 1').get()?.id
  ?? Number(db.prepare("INSERT INTO local_calendars (name, color, is_default, sort_order) VALUES ('Yuvomi', '#007AFF', 1, 0)").run().lastInsertRowid);
const ARBEIT = Number(db.prepare("INSERT INTO local_calendars (name, color, is_default, sort_order) VALUES ('Arbeit', '#FF9500', 0, 1)").run().lastInsertRowid);
const SCHULE = Number(db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', 'https://dav.example/schule/', 'Schule', '#34C759')").run().lastInsertRowid);
const FERIEN = Number(db.prepare("INSERT INTO ics_subscriptions (name, url, color, shared, created_by) VALUES ('Ferien', 'https://ics.example/ferien.ics', '#5856D6', 1, ?)").run(ADMIN).lastInsertRowid);
const LEO_PRIVAT = Number(db.prepare("INSERT INTO ics_subscriptions (name, url, color, shared, created_by) VALUES ('Leos Liga', 'https://ics.example/liga.ics', '#AF52DE', 0, ?)").run(LEO).lastInsertRowid);

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by,
                               external_source, local_calendar_id, calendar_ref_id, subscription_id)
  VALUES (?, ?, ?, 0, 'all', ?, ?, ?, ?, ?)
`);
function addEvent(title, day, hour, { source = 'local', local = null, ref = null, sub = null } = {}) {
  const start = `2026-${day}T${hour}:00`;
  return Number(insertEvent.run(title, start, `2026-${day}T${hour}:30`, ADMIN, source, local, ref, sub).lastInsertRowid);
}
// Der Standardkalender fuellt die ersten fuenf Plaetze - ohne Auswahl fiele
// alles andere hinter den Deckel.
for (let i = 0; i < 5; i += 1) addEvent(`Familie ${i + 1}`, '10-29', `1${i}`);
addEvent('Arbeit 1', '10-30', '09', { local: ARBEIT });
addEvent('Schule 1', '10-31', '08', { source: 'caldav', ref: SCHULE });
addEvent('Ferien 1', '11-01', '08', { source: 'ics', sub: FERIEN });
addEvent('Liga 1', '11-01', '10', { source: 'ics', sub: LEO_PRIVAT });
addEvent('Ohne Kalender', '11-02', '08', { source: 'google' });

const titles = (body) => body.upcomingEvents.map((e) => e.title);
const weekTitles = (body) => body.weekEvents.map((e) => e.title);
const query = (...keys) => `/?${keys.map((key) => `events_calendar=${encodeURIComponent(key)}`).join('&')}`;
const ALL = ['Familie 1', 'Familie 2', 'Familie 3', 'Familie 4', 'Familie 5'];

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne events_calendar bleibt die Antwort wie zuvor', async () => {
  assert.deepEqual(titles(await getJson('/')), ALL);
});

test('ein eigener Kalender: nur seine Termine, VOR dem Deckel - und was keinem Kalender gehoert, bleibt', async () => {
  const body = await getJson(query(`local:${ARBEIT}`));
  assert.deepEqual(titles(body), ['Arbeit 1', 'Ohne Kalender']);
  assert.deepEqual(weekTitles(body), ['Arbeit 1', 'Ohne Kalender'], 'der Wochenstreifen derselben Kachel folgt');
});

test('synchronisiert, Abo und Standardkalender sind waehlbar, auch zusammen', async () => {
  assert.deepEqual(titles(await getJson(query(`cal:${SCHULE}`))), ['Schule 1', 'Ohne Kalender']);
  assert.deepEqual(titles(await getJson(query(`sub:${FERIEN}`))), ['Ferien 1', 'Ohne Kalender']);
  assert.deepEqual(titles(await getJson(query(`cal:${SCHULE}`, `sub:${FERIEN}`))), ['Schule 1', 'Ferien 1', 'Ohne Kalender']);
  // Termine ohne local_calendar_id gehoeren dem Standardkalender.
  assert.deepEqual(titles(await getJson(query(`local:${DEFAULT_LOCAL}`))), ALL);
});

test('ein fremdes privates Abo ist nicht waehlbar: die Anfrage antwortet wie ohne Auswahl', async () => {
  assert.deepEqual(titles(await getJson(query(`sub:${LEO_PRIVAT}`))), ALL);
  assert.deepEqual(titles(await getJson(query(`sub:${LEO_PRIVAT}`, `local:${ARBEIT}`))), ['Arbeit 1', 'Ohne Kalender']);
});

test('was kein Schluessel ist, antwortet wie kein Parameter - nie mit einem Fehler', async () => {
  for (const raw of ['abc', 'local:0', 'local:-1', 'cal:abc', 'team:1', 'local:999999', '']) {
    assert.deepEqual(titles(await getJson(query(raw))), ALL, raw);
  }
  assert.deepEqual(normalizeCalendarSelection(['local:2', 'local:2', 'cal:3', 'x', 7, null]), ['local:2', 'cal:3']);
  assert.equal(normalizeCalendarSelection(Array.from({ length: 80 }, (_v, i) => `local:${i + 1}`)).length, 50);
});

test('ein ENTFERNTER Kalender faellt still aus der Auswahl; bleibt keiner, zeigt die Kachel alle', async () => {
  // Drei Wege, auf denen ein Kalender verschwindet - jeder mit Rueckbau.
  const tmpLocal = Number(db.prepare("INSERT INTO local_calendars (name, color, is_default, sort_order) VALUES ('Weg', '#000000', 0, 9)").run().lastInsertRowid);
  addEvent('Weg 1', '10-30', '12', { local: tmpLocal });
  const tmpSub = Number(db.prepare("INSERT INTO ics_subscriptions (name, url, color, shared, created_by) VALUES ('Alt', 'https://ics.example/alt.ics', '#111111', 1, ?)").run(ADMIN).lastInsertRowid);
  addEvent('Alt 1', '10-30', '13', { source: 'ics', sub: tmpSub });
  const tmpCal = Number(db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', 'weg@example', 'Getrennt', '#222222')").run().lastInsertRowid);
  addEvent('Getrennt 1', '10-30', '14', { source: 'google', ref: tmpCal });
  const saved = [`local:${tmpLocal}`, `sub:${tmpSub}`, `cal:${tmpCal}`, `local:${ARBEIT}`];
  assert.deepEqual(titles(await getJson(query(...saved))), ['Arbeit 1', 'Weg 1', 'Alt 1', 'Getrennt 1', 'Ohne Kalender']);

  // Der lokale Kalender wird geloescht (seine Termine fallen in den Standard),
  // das Abo entfernt, das Konto getrennt (seine Termine verschwinden, die
  // Zeile in external_calendars bleibt stehen - so arbeitet der Sync).
  db.prepare('UPDATE calendar_events SET local_calendar_id = NULL WHERE local_calendar_id = ?').run(tmpLocal);
  db.prepare('DELETE FROM local_calendars WHERE id = ?').run(tmpLocal);
  db.prepare('DELETE FROM calendar_events WHERE subscription_id = ?').run(tmpSub);
  db.prepare('DELETE FROM ics_subscriptions WHERE id = ?').run(tmpSub);
  db.prepare('DELETE FROM calendar_events WHERE calendar_ref_id = ?').run(tmpCal);
  try {
    assert.deepEqual(titles(await getJson(query(...saved))), ['Arbeit 1', 'Ohne Kalender'],
      'die entfernten fallen weg, der uebrige bleibt gewaehlt');
    const gone = await getJson(query(...saved.slice(0, 3)));
    assert.deepEqual(titles(gone), ['Familie 1', 'Familie 2', 'Familie 3', 'Familie 4', 'Familie 5'],
      'nur Entferntes gewaehlt: die Kachel zeigt alle Kalender, nicht nichts');
    assert.ok(gone.weekEvents.length > 2, 'auch der Streifen ist ungefiltert');
  } finally {
    db.prepare("DELETE FROM calendar_events WHERE title = 'Weg 1'").run();
  }
});

// --------------------------------------------------------------------------
// 2. Der Katalog
// --------------------------------------------------------------------------

test('GET /calendar/calendars traegt die waehlbaren Kalender als `sources` neben `data`', async () => {
  const body = await getJson('/calendar/calendars');
  assert.ok(Array.isArray(body.data) && body.data.every((row) => typeof row.id === 'number'), '`data` bleibt die Liste der eigenen');
  const keys = body.sources.map((source) => source.key);
  assert.deepEqual(keys.slice(0, 2), [`local:${DEFAULT_LOCAL}`, `local:${ARBEIT}`], 'eigene zuerst, in Verwaltungsreihenfolge');
  assert.ok(keys.includes(`cal:${SCHULE}`));
  assert.ok(keys.includes(`sub:${FERIEN}`));
  assert.ok(!keys.includes(`sub:${LEO_PRIVAT}`), 'Leos privates Abo nicht');
  assert.equal(body.sources.find((s) => s.key === `cal:${SCHULE}`).name, 'Schule');
  currentUser = LEO;
  try {
    assert.ok((await getJson('/calendar/calendars')).sources.some((s) => s.key === `sub:${LEO_PRIVAT}`), 'fuer Leo schon');
  } finally {
    currentUser = ADMIN;
  }
});

// --------------------------------------------------------------------------
// 3. Die Ablage
// --------------------------------------------------------------------------

const calendarTile = (options) => [{ id: 'calendar', visible: true, order: 0, size: '1x2', ...(options ? { options } : {}) }];

test('die Auswahl ueberlebt das Speichern und fuehrt zur gefilterten Antwort', async () => {
  const keys = [`local:${ARBEIT}`, `cal:${SCHULE}`];
  try {
    const res = await fetch(`${base}/preferences`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboard_widgets: calendarTile({ calendars: keys }) }),
    });
    assert.equal(res.status, 200);
    const mine = (await getJson('/preferences')).data.dashboard_widgets;
    assert.deepEqual(mine.find((w) => w.id === 'calendar').options, { calendars: keys });
    assert.deepEqual(titles(await getJson(widgets.dashboardQuery(mine).replace('/dashboard', '/'))), ['Arbeit 1', 'Schule 1', 'Ohne Kalender']);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key LIKE 'dashboard_widgets%'").run();
  }
});

// --------------------------------------------------------------------------
// 4. Der Browser
// --------------------------------------------------------------------------

test('dashboardQuery: die Auswahl reist als wiederholter Parameter - und mit der Wand', () => {
  const q = (options) => widgets.dashboardQuery(calendarTile(options));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ calendars: [] }), '/dashboard');
  assert.equal(q({ calendars: ['local:2', 'cal:5'] }), '/dashboard?events_calendar=local%3A2&events_calendar=cal%3A5');
  assert.equal(q({ calendars: ['local:2', 'local:2', 'x', 4, 'sub:0'] }), '/dashboard?events_calendar=local%3A2', 'Fremdwerte werden nicht zur Anfrage');
  assert.equal(q({ calendars: 'alle' }), '/dashboard');
  assert.equal(widgets.dashboardRequest(q({ calendars: ['sub:3'] }), { wall: true }), '/dashboard?events_calendar=sub%3A3&audience=household',
    'die Wand liest dieselbe Kacheleinstellung');
});

test('die Haushaltsfassung (Wand) folgt derselben Auswahl', async () => {
  assert.deepEqual(titles(await getJson(`${query(`local:${ARBEIT}`)}&audience=household`)), ['Arbeit 1', 'Ohne Kalender']);
});

const { __test: dash } = await import('../public/pages/dashboard.js');

test('Kachel: Liste und "weitere"-Hinweis folgen der Auswahl', async () => {
  const now = new Date(NOW);
  const prevWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  try {
    // 1x1 zeigt drei Zeilen: ohne Auswahl kommen mehr, die Fusszeile steht da.
    const plain = dash.renderUpcomingEvents((await getJson('/')).upcomingEvents, { now, limit: 5, rows: 3 });
    assert.match(plain, /dashboard\.eventsMoreAhead/);
    // Mit Auswahl passen alle in die drei Zeilen - nichts "weiter".
    const picked = dash.renderUpcomingEvents((await getJson(query(`local:${ARBEIT}`))).upcomingEvents, { now, limit: 5, rows: 3 });
    assert.match(picked, /Arbeit 1/);
    assert.doesNotMatch(picked, /Familie 1/);
    assert.doesNotMatch(picked, /dashboard\.eventsMoreAhead/);
  } finally {
    globalThis.window = prevWindow;
  }
});

const SOURCES = [
  { key: 'local:1', name: 'Yuvomi' },
  { key: 'local:4', name: 'Arbeit & "Büro"' },
  { key: 'cal:9', name: 'Schule' },
  { key: 'sub:3', name: 'Ferien' },
];

/** Den Dialog oeffnen, ohne DOM: der Stub faengt Inhalt und Speichern-Handler. */
async function openCalendarDialog(current, { sources, picked = [] }) {
  let content = null;
  let submit = null;
  const toasts = [];
  const prev = { open: globalThis.__openModal, close: globalThis.__closeModal, window: globalThis.window };
  const field = (selector) => {
    if (selector === '[data-action="cancel"]') return { addEventListener() {} };
    if (selector === '#widget-options-form') return { addEventListener: (_type, handler) => { submit = handler; } };
    if (selector === 'input[name="cal-birthdays"]') return { checked: true };
    return null;
  };
  globalThis.window = { yuvomi: { showToast: (message, type) => toasts.push([message, type]) } };
  globalThis.__openModal = (config) => {
    content = config.content;
    config.onSave({
      querySelector: field,
      querySelectorAll: (selector) => (selector === 'input[name="cal-calendar"]:checked' ? picked.map((value) => ({ value })) : []),
    });
  };
  globalThis.__closeModal = () => true;
  try {
    const result = dash.openWidgetOptions('calendar', current, { loadCalendars: async () => sources });
    await Promise.resolve();
    await Promise.resolve();
    if (content === null) return { content, saved: await result, toasts };
    submit({ preventDefault() {} });
    return { content, saved: await result, toasts };
  } finally {
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
    globalThis.window = prev.window;
  }
}
const choices = (content) => [...content.matchAll(/<input type="checkbox" name="cal-calendar" value="([^"]+)"\s+(checked)?>\s*<span>([^<]*)<\/span>/g)]
  .map((m) => ({ key: m[1], checked: Boolean(m[2]), name: m[3] }));

test('Dialog: jeder Kalender ist waehlbar, ohne Auswahl ist nichts angehakt', async () => {
  const { content } = await openCalendarDialog({}, { sources: SOURCES });
  assert.deepEqual(choices(content), [
    { key: 'local:1', checked: false, name: 'Yuvomi' },
    { key: 'local:4', checked: false, name: 'Arbeit &amp; &quot;Büro&quot;' },
    { key: 'cal:9', checked: false, name: 'Schule' },
    { key: 'sub:3', checked: false, name: 'Ferien' },
  ]);
  assert.match(content, /dashboard\.optionCalendarCalendars</);
  assert.match(content, /dashboard\.optionCalendarCalendarsHint/);
});

test('Dialog: Gespeichertes ist angehakt, ein entfernter Kalender hat keine Zeile und faellt beim Speichern weg', async () => {
  const { content, saved } = await openCalendarDialog({ calendars: ['cal:9', 'local:77'] }, { sources: SOURCES, picked: ['cal:9'] });
  assert.deepEqual(choices(content).filter((c) => c.checked).map((c) => c.key), ['cal:9']);
  assert.ok(!content.includes('local:77'));
  assert.deepEqual(saved, { calendars: ['cal:9'] });
});

test('Dialog: alles abgewaehlt heisst "alle" - nichts wird gespeichert, die anderen Optionen bleiben', async () => {
  assert.deepEqual((await openCalendarDialog({ calendars: ['cal:9'] }, { sources: SOURCES, picked: [] })).saved, {});
  assert.deepEqual((await openCalendarDialog({}, { sources: SOURCES, picked: ['sub:3', 'local:1'] })).saved, { calendars: ['sub:3', 'local:1'] });
});

test('Dialog: mit nur einem Kalender gibt es nichts zu waehlen', async () => {
  const { content, saved } = await openCalendarDialog({}, { sources: [SOURCES[0]] });
  assert.doesNotMatch(content, /cal-calendar/);
  assert.match(content, /cal-scope/, 'die anderen Optionen stehen weiter da');
  assert.deepEqual(saved, {});
});

test('Dialog: scheitert der Katalog, geht er nicht auf und die Auswahl bleibt', async () => {
  const { content, saved, toasts } = await openCalendarDialog({ calendars: ['cal:9'] }, { sources: null });
  assert.equal(content, null);
  assert.equal(saved, null);
  assert.deepEqual(toasts, [['dashboard.loadError', 'danger']]);
});

test('Lader: der echte Lader liest `sources` von /calendar/calendars und meldet Fehler als null', async () => {
  const calls = [];
  assert.deepEqual(await dash.loadCalendarSources(async (path) => { calls.push(path); return { data: [], sources: SOURCES }; }), SOURCES);
  assert.deepEqual(calls, ['/calendar/calendars']);
  assert.equal(await dash.loadCalendarSources(async () => { throw new Error('offline'); }), null);
  assert.equal(await dash.loadCalendarSources(async () => ({ data: [] })), null, 'ein Server ohne Katalog ist kein leerer Katalog');
});
