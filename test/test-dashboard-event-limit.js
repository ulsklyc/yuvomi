/**
 * Modul: Uebersicht - wie viele Termine die Kalender-Kachel listet (#1680)
 * Zweck: Die Kachel zeigte fest fuenf Kommende, und fuenf stand an zwei
 *        Stellen (Route und Renderer). Seit #1680 waehlt jede Person 5, 8 oder
 *        12 im Optionen-Dialog der Kachel. Geprueft wird der ganze Weg:
 *
 *        1. Route: `events_limit` liefert die Stufe, alles ausserhalb der
 *           Allowlist ist fuenf, ohne Parameter bleibt die Antwort wie zuvor.
 *           Beendete von heute zaehlen nicht mit, `familyEvents` und
 *           `weekEvents` folgen der Stufe nicht.
 *        2. Ablage: die Option geht durch `PUT /preferences` (Form, nicht
 *           Bedeutung), gehoert der Person, reist mit der Haushaltsvorgabe und
 *           faellt beim Zuruecksetzen auf sie zurueck.
 *        3. Browser: der Dialog bietet die drei Stufen, speichert nur die
 *           Abweichung; die Anfrage traegt sie; die Kachel rendert n Zeilen in
 *           jeder Listengroesse, 2x1 bleibt der Wochenstreifen, Heute-Blatt
 *           und Wand behalten ihren Deckel.
 *
 *        Uhr und Zone sind festgenagelt (Berlin wie die Demo-Saat) mit einem
 *        Gegenlauf in einer Zone, die den Tag verschiebt.
 *
 *        4. Was die Stufe NICHT sein darf (Codex-Review zu PR #1684): ein
 *           Filter fuer die Zahlen der Navigation - sonst holt der Router die
 *           Antwort bei jedem Kaltstart ein zweites Mal -, und beim
 *           Veroeffentlichen als Haushaltsvorgabe darf die alte Antwort nicht
 *           stehen bleiben.
 *
 * Ausfuehren: npm run test:dashboard-event-limit
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import { readFileSync } from 'node:fs';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-event-limit-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { dashboardPaths } = await import('../server/openapi/paths/dashboard.js');
const widgets = await import('../public/utils/dashboard-widgets.js');
const limits = await import('../public/utils/dashboard-event-limit.js');

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
const ADMIN = Number(addUser.run(`limit-admin-${randomUUID()}`, 'Anna', 'admin', 'parent').lastInsertRowid);
const LEO = Number(addUser.run(`limit-leo-${randomUUID()}`, 'Leo', 'member', 'child').lastInsertRowid);

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

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES (?, ?, ?, 0, 'all', ?, NULL)
`);
const addEvent = (title, start, end) => Number(insertEvent.run(title, start, end, ADMIN).lastInsertRowid);
const clearEvents = () => db.prepare('DELETE FROM calendar_events').run();
const titles = (events) => events.map((e) => e.title);
const pad = (n) => String(n).padStart(2, '0');

// Donnerstag, 24.09.2026, 14:00 in Berlin.
const THU_14_BERLIN = '2026-09-24T12:00:00Z';

/** Drei beendete von heute, dann vierzehn Kommende - einer je Tag ab morgen. */
function seedFullCalendar() {
  clearEvents();
  for (const h of ['08', '09', '10']) addEvent(`Vorbei ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`);
  for (let i = 1; i <= 14; i += 1) {
    const day = `2026-${i <= 6 ? '09' : '10'}-${pad(i <= 6 ? 24 + i : i - 6)}`;
    addEvent(`Kommt ${pad(i)}`, `${day}T10:00`, `${day}T11:00`);
  }
}
const ahead = (events) => titles(events).filter((title) => title.startsWith('Kommt'));
const firstAhead = (n) => Array.from({ length: n }, (_, i) => `Kommt ${pad(i + 1)}`);

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne events_limit bleibt es bei fuenf Kommenden', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  assert.deepEqual(ahead((await getJson('/')).upcomingEvents), firstAhead(5));
}));

for (const step of [8, 12]) {
  test(`events_limit=${step} liefert ${step} Kommende`, withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
    seedFullCalendar();
    assert.deepEqual(ahead((await getJson(`/?events_limit=${step}`)).upcomingEvents), firstAhead(step));
  }));
}

test('events_limit=5 ist die Vorgabe und liefert dasselbe wie kein Parameter', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  assert.deepEqual(ahead((await getJson('/?events_limit=5')).upcomingEvents), firstAhead(5));
}));

test('alles ausserhalb der Allowlist ist fuenf - kein Bereich, kein Runden', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const outside = [
    'events_limit=500', 'events_limit=7', 'events_limit=abc', 'events_limit=', 'events_limit=0', 'events_limit=-8',
    'events_limit=8.0', 'events_limit=%208', 'events_limit=08', 'events_limit=1e1', 'events_limit=12abc',
    // Express macht aus dem doppelten Parameter ein Array und aus der Klammer ein Objekt.
    'events_limit=8&events_limit=12', 'events_limit[]=12', 'events_limit[a]=12',
  ];
  for (const query of outside) {
    assert.deepEqual(ahead((await getJson(`/?${query}`)).upcomingEvents), firstAhead(5), `?${query} darf nicht mehr als fuenf liefern`);
  }
}));

test('beendete Termine von heute kommen obendrauf und verbrauchen die Stufe nicht (#1449)', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const events = (await getJson('/?events_limit=12')).upcomingEvents;
  assert.deepEqual(titles(events).filter((title) => title.startsWith('Vorbei')), ['Vorbei 08', 'Vorbei 09', 'Vorbei 10']);
  assert.equal(ahead(events).length, 12, 'zwoelf Kommende NEBEN den drei beendeten');
}));

test('weniger Termine als die Stufe: die Antwort ist kuerzer, nicht aufgefuellt', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  for (let i = 1; i <= 6; i += 1) addEvent(`Kommt ${pad(i)}`, `2026-09-${24 + i}T10:00`, `2026-09-${24 + i}T11:00`);
  assert.deepEqual(ahead((await getJson('/?events_limit=12')).upcomingEvents), firstAhead(6));
}));

test('die Stufe gilt der Liste: weekEvents und familyEvents bleiben, wie sie sind', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const plain = await getJson('/');
  const twelve = await getJson('/?events_limit=12');
  assert.deepEqual(twelve.weekEvents, plain.weekEvents);
  assert.deepEqual(twelve.familyEvents, plain.familyEvents);
}));

test('die Stufe vertraegt sich mit „nur meine" und greift NACH dem Filter', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const assign = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  const rows = db.prepare("SELECT id, title FROM calendar_events WHERE title LIKE 'Kommt %' ORDER BY title").all();
  // Jeder zweite gehoert Anna: sieben eigene unter vierzehn.
  rows.forEach((row, index) => { if (index % 2 === 1) assign.run(row.id, ADMIN); });
  const mine = ahead((await getJson('/?events_scope=mine&events_limit=8')).upcomingEvents);
  assert.deepEqual(mine, ['02', '04', '06', '08', '10', '12', '14'].map((n) => `Kommt ${n}`),
    'acht ist der Deckel NACH dem Filter - sonst blieben vier von acht');
}));

// Gegenlauf: in Honolulu ist derselbe Augenblick noch der Vormittag des 24.,
// und die drei „beendeten" enden dort ebenfalls vor jetzt (02:00 Ortszeit waere
// es nicht) - die Stufe haengt an keiner Tagesgrenze.
test('Gegenlauf Honolulu: die Stufe zaehlt dort genauso', withClock('2026-09-25T02:00:00Z', 'Pacific/Honolulu', async () => {
  seedFullCalendar();
  assert.equal(ahead((await getJson('/?events_limit=8')).upcomingEvents).length, 8);
  assert.equal(ahead((await getJson('/')).upcomingEvents).length, 5);
}));

test('OpenAPI nennt den Parameter mit genau den Stufen der Route', () => {
  const params = dashboardPaths()['/api/v1/dashboard'].get.parameters;
  const param = params.find((p) => p.name === 'events_limit' && p.in === 'query');
  assert.ok(param, 'events_limit fehlt in der OpenAPI-Beschreibung von GET /dashboard');
  assert.deepEqual(param.schema.enum, [...limits.EVENT_LIMIT_STEPS]);
  assert.equal(param.schema.default, limits.EVENT_LIMIT_DEFAULT);
  assert.equal(param.required, false);
});

// --------------------------------------------------------------------------
// 2. Die Ablage: Form statt Bedeutung, je Person, mit Haushaltsvorgabe
// --------------------------------------------------------------------------

const readPrefs = async () => (await getJson('/preferences')).data;
async function writePrefs(body) {
  const res = await fetch(`${base}/preferences`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.status;
}
function clearDashboardPreferences() {
  db.prepare(`
    DELETE FROM sync_config
    WHERE key IN ('dashboard_widgets', 'dashboard_widgets_default')
       OR key LIKE 'dashboard_widgets:user:%'
  `).run();
}
const calendarTile = (options) => [{ id: 'calendar', visible: true, order: 0, size: '1x2', ...(options ? { options } : {}) }];
const calendarOptions = (config) => config.find((w) => w.id === 'calendar')?.options;

test('die Stufe ueberlebt das Speichern und gehoert der Person', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 8 }) }), 200);
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 8 });
    assert.equal(widgets.dashboardQuery((await readPrefs()).dashboard_widgets), '/dashboard?events_limit=8');

    currentUser = LEO;
    assert.deepEqual((await readPrefs()).dashboard_widgets, [], 'Leos Kachel bleibt unberuehrt');
    assert.equal(widgets.dashboardQuery((await readPrefs()).dashboard_widgets), '/dashboard');
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('die Vorgabe des Haushalts traegt die Stufe, und Zuruecksetzen fuehrt zu ihr zurueck', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets_default: calendarTile({ limit: 12 }) }), 200);

    currentUser = LEO;
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 12 }, 'wer nichts Eigenes hat, bekommt die Vorgabe');
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 8 }) }), 200);
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 8 });
    assert.equal(await writePrefs({ dashboard_widgets: null }), 200);
    const back = await readPrefs();
    assert.deepEqual(calendarOptions(back.dashboard_widgets), { limit: 12 });
    assert.equal(back.dashboard_follows_default, true);
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('ein gespeicherter Fremdwert wird nicht zur Anfrage: die Klemme sitzt hinter der Ablage', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    // Die Ablage prueft die Form (endliche Zahl) und kennt die Bedeutung nicht -
    // 500 kommt also hinein. Anfrage und Kachel klemmen.
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 500 }) }), 200);
    const stored = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(calendarOptions(stored), { limit: 500 });
    assert.equal(widgets.dashboardQuery(stored), '/dashboard');
  } finally {
    clearDashboardPreferences();
  }
});

// --------------------------------------------------------------------------
// 3. Der Browser: Klemme, Anfrage, Dialog, Kachel
// --------------------------------------------------------------------------

test('clampEventLimit: nur 5, 8 und 12, als Zahl oder als genau diese Ziffern', () => {
  assert.deepEqual([...limits.EVENT_LIMIT_STEPS], [5, 8, 12]);
  assert.equal(limits.EVENT_LIMIT_DEFAULT, 5);
  for (const step of [5, 8, 12]) {
    assert.equal(limits.clampEventLimit(step), step);
    assert.equal(limits.clampEventLimit(String(step)), step);
  }
  for (const other of [undefined, null, '', 0, 7, 500, -8, 8.5, '8.0', ' 8', '08', 'abc', NaN, Infinity, true, [8], ['8', '12'], { a: 12 }]) {
    assert.equal(limits.clampEventLimit(other), 5, `${JSON.stringify(other)} ist keine Stufe`);
  }
});

test('dashboardQuery: die Stufe reist nur, wenn sie von der Vorgabe abweicht', () => {
  const q = (options) => widgets.dashboardQuery(calendarTile(options));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ limit: 5 }), '/dashboard', 'fuenf ist der Auslieferungszustand und steht in keiner Anfrage');
  assert.equal(q({ limit: 8 }), '/dashboard?events_limit=8');
  assert.equal(q({ limit: 12 }), '/dashboard?events_limit=12');
  assert.equal(q({ limit: 7 }), '/dashboard');
  assert.equal(q({ limit: 500 }), '/dashboard');
  assert.equal(q({ scope: 'mine', birthdays: 'hide', limit: 12 }),
    '/dashboard?events_scope=mine&events_birthdays=hide&events_limit=12');
});

const tz = await import('/utils/timezone.js');
const { __test: dash } = await import('../public/pages/dashboard.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

function inBrowser(iso, zone, fn, { phone = false } = {}) {
  return async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    tz.setDisplayTimeZone(zone);
    const prevWindow = global.window;
    global.window = {
      yuvomi: { isModuleDisabled: () => false },
      matchMedia: (query) => ({ matches: phone && query === '(max-width: 639px)' }),
    };
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

const ev = (id, title, start, end) => ({
  id, title, start_datetime: start, end_datetime: end, all_day: 0, assigned_users: [],
});
/** Wie die Route sie liefert: beendete von heute, dann `count` Kommende. */
function tileEvents(count, { ended = 0 } = {}) {
  const list = [];
  for (let i = 0; i < ended; i += 1) list.push(ev(100 + i, `Vorbei ${pad(8 + i)}`, `2026-09-24T${pad(8 + i)}:00`, `2026-09-24T${pad(8 + i)}:30`));
  for (let i = 1; i <= count; i += 1) {
    const day = `2026-${i <= 6 ? '09' : '10'}-${pad(i <= 6 ? 24 + i : i - 6)}`;
    list.push(ev(i, `Kommt ${pad(i)}`, `${day}T10:00`, `${day}T11:00`));
  }
  return list;
}
const rowTitles = (html) => [...html.matchAll(/event-item__title">([^<]*)</g)].map((m) => m[1]);
const aheadRows = (html) => rowTitles(html).filter((title) => title.startsWith('Kommt'));

/** Den Dialog oeffnen, ohne DOM: der Stub faengt Inhalt und Speichern-Handler. */
async function openCalendarDialog(current, picked) {
  let content = '';
  let submit = null;
  const prev = { open: globalThis.__openModal, close: globalThis.__closeModal };
  const field = (selector) => {
    if (selector === 'input[name="cal-scope"]:checked') return { value: picked.scope ?? 'all' };
    if (selector === 'input[name="cal-birthdays"]') return { checked: picked.birthdays !== false };
    if (selector === 'input[name="cal-limit"]:checked') return picked.limit === undefined ? null : { value: String(picked.limit) };
    if (selector === '[data-action="cancel"]') return { addEventListener() {} };
    if (selector === '#widget-options-form') return { addEventListener: (_type, handler) => { submit = handler; } };
    return null;
  };
  globalThis.__openModal = (config) => {
    content = config.content;
    config.onSave({ querySelector: field });
  };
  globalThis.__closeModal = () => true;
  try {
    const result = dash.openWidgetOptions('calendar', current);
    // openWidgetOptions ist async: der Dialog steht erst nach einem Takt.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(typeof submit, 'function', 'der Dialog hat keinen Speichern-Handler verdrahtet');
    submit({ preventDefault() {} });
    return { content, saved: await result };
  } finally {
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
  }
}
const limitChoices = (content) => [...content.matchAll(/<input type="radio" name="cal-limit" value="(\d+)" (checked)?/g)]
  .map((m) => ({ value: Number(m[1]), checked: Boolean(m[2]) }));

test('Dialog: die Kalender-Kachel bietet die drei Stufen, und fuenf ist vorgewaehlt', inBrowser(THU_14_BERLIN, 'Europe/Berlin', async () => {
  const { content } = await openCalendarDialog({}, { limit: 5 });
  assert.deepEqual(limitChoices(content), [
    { value: 5, checked: true }, { value: 8, checked: false }, { value: 12, checked: false },
  ]);
  assert.match(content, /dashboard\.optionCalendarLimit</, 'die Gruppe traegt ihre Ueberschrift ueber t()');
  assert.match(content, /dashboard\.optionCalendarLimitHint/, 'und den Hinweis auf den Wochenstreifen');
  // Die beiden aelteren Optionen stehen weiter da - die dritte kommt dazu.
  assert.match(content, /name="cal-scope"/);
  assert.match(content, /name="cal-birthdays"/);
}));

test('Dialog: die gespeicherte Stufe ist vorgewaehlt, ein Fremdwert zeigt die Vorgabe', inBrowser(THU_14_BERLIN, 'Europe/Berlin', async () => {
  assert.deepEqual(limitChoices((await openCalendarDialog({ limit: 12 }, { limit: 12 })).content).filter((c) => c.checked), [{ value: 12, checked: true }]);
  assert.deepEqual(limitChoices((await openCalendarDialog({ limit: 500 }, { limit: 5 })).content).filter((c) => c.checked), [{ value: 5, checked: true }]);
}));

test('Dialog: gespeichert wird nur die Abweichung, als Zahl', inBrowser(THU_14_BERLIN, 'Europe/Berlin', async () => {
  assert.deepEqual((await openCalendarDialog({}, { limit: 8 })).saved, { limit: 8 });
  assert.deepEqual((await openCalendarDialog({}, { limit: 12, scope: 'mine' })).saved, { scope: 'mine', limit: 12 });
  assert.deepEqual((await openCalendarDialog({ limit: 12 }, { limit: 5 })).saved, {}, 'fuenf wird nicht gespeichert - wie scope: all');
  assert.deepEqual((await openCalendarDialog({}, { limit: 99 })).saved, {}, 'ein Wert, den es im Dialog nicht gibt, kommt nicht ins Layout');
  assert.deepEqual((await openCalendarDialog({}, {})).saved, {}, 'ohne gewaehltes Radio bleibt es bei der Vorgabe');
}));

for (const [limit, expected] of [[undefined, 5], [5, 5], [8, 8], [12, 12], [7, 5], [500, 5], ['8', 8]]) {
  test(`Kachel: limit ${JSON.stringify(limit)} rendert ${expected} Kommende`, inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
    const html = dash.renderCalendarWidget({ upcomingEvents: tileEvents(14) }, '1x2', limit === undefined ? {} : { limit });
    assert.deepEqual(aheadRows(html), firstAhead(expected));
  }));
}

test('Kachel: jede Listengroesse traegt die gewaehlte Zahl, 2x1 bleibt der Wochenstreifen', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14), weekEvents: [] };
  for (const size of ['1x1', '1x2', '2x2']) {
    for (const limit of [8, 12]) {
      assert.equal(aheadRows(dash.renderCalendarWidget(data, size, { limit })).length, limit, `${size} mit ${limit}`);
    }
  }
  const strip = dash.renderCalendarWidget(data, '2x1', { limit: 12 });
  assert.match(strip, /week-strip/, '2x1 ist die Woche');
  assert.equal(rowTitles(strip).length, 0, 'und zeigt keine Liste, was immer gewaehlt ist');
}));

test('Kachel: auf dem Telefon gilt dieselbe Zahl', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14) };
  assert.equal(dash.listRowCap('1x2'), 3, 'Vorbedingung: die Telefon-Buehne ist aktiv');
  assert.equal(aheadRows(dash.renderCalendarWidget(data, '1x2', { limit: 12 })).length, 12);
  assert.equal(aheadRows(dash.renderCalendarWidget(data, '1x2', {})).length, 5);
}, { phone: true }));

test('Kachel: beendete von heute stehen darueber und verbrauchen die Stufe nicht', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const html = dash.renderCalendarWidget({ upcomingEvents: tileEvents(14, { ended: 3 }) }, '1x2', { limit: 8 });
  assert.deepEqual(aheadRows(html), firstAhead(8));
  assert.deepEqual(rowTitles(html).filter((title) => title.startsWith('Vorbei')), ['Vorbei 09', 'Vorbei 10'], 'die zwei juengsten beendeten');
  assert.equal((html.match(/event-item--ended/g) ?? []).length, 2);
  assert.match(html, /event-list__earlier/, 'der dritte faltet sich in die Zeile darueber');
}));

test('Kachel: weniger Termine als die Stufe - keine Luecke, kein Badge, Leerzustand bleibt', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const some = dash.renderCalendarWidget({ upcomingEvents: tileEvents(3) }, '1x2', { limit: 12 });
  assert.deepEqual(aheadRows(some), firstAhead(3));
  assert.doesNotMatch(some, /class="widget__badge"/, 'die Liste traegt weiter keine Zahl im Kopf');
  const none = dash.renderCalendarWidget({ upcomingEvents: [] }, '1x2', { limit: 12 });
  assert.match(none, /dashboard\.noEvents/);
  assert.match(none, /widget__empty/);
}));

test('Kachel: zurueck auf fuenf schneidet sofort, auch wenn die alte Antwort zwoelf traegt', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  // Im Anpassen-Modus steht bis zum Speichern die Antwort der alten Anfrage.
  assert.deepEqual(aheadRows(dash.renderCalendarWidget({ upcomingEvents: tileEvents(12) }, '1x2', {})), firstAhead(5));
}));

test('Raster: die Option der Kachel kommt beim Renderer an', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14), weekEvents: [] };
  const layout = (options) => dash.renderDashboardLayout(calendarTile(options), data, null, 'EUR');
  assert.deepEqual(aheadRows(layout({ limit: 8 })), firstAhead(8));
  assert.deepEqual(aheadRows(layout({ limit: 12 })), firstAhead(12));
  assert.deepEqual(aheadRows(layout(undefined)), firstAhead(5));
}));

test('Heute-Blatt und Wand behalten ihren Deckel, auch mit zwoelf Terminen in der Antwort', inBrowser('2026-09-24T04:00:00Z', 'Europe/Berlin', () => {
  // Zwoelf Termine HEUTE, ab 08:00 - nur was heute ist, kommt ueberhaupt ins Blatt.
  const today = Array.from({ length: 12 }, (_, i) => ev(i + 1, `Heute ${pad(i + 8)}`, `2026-09-24T${pad(i + 8)}:00`, `2026-09-24T${pad(i + 8)}:30`));
  const five = today.slice(0, 5);
  const sheet = (events) => dash.buildTodayCockpitModel({ upcomingEvents: events }, [], { cap: dash.PROGRAM_ROW_CAP, groupOverdue: false });
  const wall = (events) => dash.buildTodayCockpitModel({ upcomingEvents: events }, [], { cap: dash.WALL_ROW_CAP, groupOverdue: false });
  assert.equal(sheet(today).rows.length, sheet(five).rows.length + 1, 'Vorbedingung: das Blatt war mit fuenf nicht voll (sechs Zeilen Platz)');
  assert.equal(sheet(today).rows.length, dash.PROGRAM_ROW_CAP, 'das Blatt zeigt nicht mehr als seinen Deckel');
  assert.equal(wall(today).rows.length, dash.WALL_ROW_CAP, 'die Wand zeigt nicht mehr als ihren Deckel');
  assert.equal(wall(today).rows.length, wall(five).rows.length, 'und nicht mehr Zeilen als mit fuenf');
  assert.equal(sheet(today).overflow, 12 - dash.PROGRAM_ROW_CAP, 'der Rest steht hinter „+N weitere"');
}));

// --------------------------------------------------------------------------
// 4. Die Stufe ist kein Filter, und Veroeffentlichen holt die Antwort neu
// --------------------------------------------------------------------------

const badges = await import('../public/utils/nav-badges.js');

test('dashboardQueryFiltersCounts: events_limit allein ist kein Filter, alles andere schon', () => {
  const f = widgets.dashboardQueryFiltersCounts;
  assert.equal(f('/dashboard'), false);
  assert.equal(f('/dashboard?events_limit=8'), false);
  assert.equal(f('/dashboard?events_limit=12'), false);
  assert.equal(f(widgets.dashboardQuery(calendarTile({ limit: 12 }))), false, 'der Pfad, den die Seite wirklich baut');
  // Allowlist: was nicht bekannt zahlenneutral ist, gilt als Filter.
  assert.equal(f('/dashboard?tasks_category=household'), true);
  assert.equal(f('/dashboard?notes_category=3'), true);
  assert.equal(f('/dashboard?events_scope=mine'), true);
  assert.equal(f('/dashboard?events_birthdays=hide'), true);
  assert.equal(f('/dashboard?events_limit=12&tasks_category=household'), true, 'die Stufe entschuldigt keinen Filter daneben');
  assert.equal(f('/dashboard?events_scope=mine&events_limit=12'), true);
  assert.equal(f('/dashboard?something_new=1'), true);
  assert.equal(f(undefined), false);
});

test('die Zahlen der Navigation sind mit und ohne Stufe dieselben - und mit einem echten Filter andere', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  db.prepare('DELETE FROM tasks').run();
  const addTask = db.prepare("INSERT INTO tasks (title, priority, status, category, due_date, created_by) VALUES (?, 'high', 'open', ?, ?, ?)");
  addTask.run('Haushalt ueberfaellig', 'household', '2026-09-20', ADMIN);
  addTask.run('Haushalt offen', 'household', '2026-09-30', ADMIN);
  addTask.run('Anderes ueberfaellig', 'other', '2026-09-21', ADMIN);
  try {
    const counts = (data) => ({
      module: badges.moduleCountsFrom(data, { isAdmin: true, shoppingVisible: true }),
      nav: badges.navBadgeCountsFrom(data),
    });
    const plain = counts(await getJson('/'));
    assert.equal(plain.module.tasks, 3, 'Vorbedingung: drei offene Aufgaben werden gezaehlt');
    assert.equal(plain.nav['/tasks'], 2, 'Vorbedingung: zwei davon ueberfaellig');
    for (const step of [8, 12]) {
      assert.deepEqual(counts(await getJson(`/?events_limit=${step}`)), plain, `events_limit=${step} darf keine Zahl bewegen`);
    }
    // Die Messung sieht einen Filter, wenn es einer ist - sonst waere das Gleichheitszeichen oben nichts wert.
    const filtered = counts(await getJson('/?tasks_category=household'));
    assert.equal(filtered.module.tasks, 2);
    assert.equal(filtered.nav['/tasks'], 1);
  } finally {
    db.prepare('DELETE FROM tasks').run();
  }
}));

// Beide Stellen sind Closures in `render()` und ohne Browser nicht aufrufbar
// (dieselbe Lage wie in test-waste-dashboard.js). Der Text haelt deshalb den
// AUFRUF fest; das Verhalten dahinter - die geteilte Funktion und die Zahlen -
// messen die zwei Tests darueber, den Ablauf die Browser-Probe im PR.
const pageSource = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
/** Der Rumpf einer Funktion bis zur schliessenden Klammer auf ihrer Einrueckung. */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} nicht gefunden`);
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `Ende von ${signature} nicht gefunden`);
  return source.slice(start, end);
}

test('die Seite reicht dem Zahlenspeicher die Antwort nach der geteilten Regel, nicht nach „hat Parameter"', () => {
  const call = /primeModuleCountsFrom\?\.\(dashRes, \{\s*filtered: ([^\n]+?),?\s*\}\)/.exec(pageSource);
  assert.ok(call, 'der Aufruf von primeModuleCountsFrom ist nicht mehr zu finden');
  assert.equal(call[1], "dashboardQueryFiltersCounts(layoutHintQuery('/dashboard'))");
});

test('„Als Vorgabe fuer alle" holt die Antwort neu, wenn sich die Abfrage geaendert hat', () => {
  const body = functionBody(pageSource, 'async function publishHouseholdDefault()');
  const before = body.indexOf('const previousQuery = dashboardQuery(savedWidgetConfig);');
  const saved = body.indexOf('savedWidgetConfig = widgetConfig.map(');
  const reload = body.indexOf('await reloadIfQueryChanged(previousQuery);');
  const rebuild = body.indexOf('rebuildDashboard(widgetConfig);');
  assert.ok(before >= 0, 'der Pfad VOR dem Speichern wird nicht festgehalten');
  assert.ok(reload >= 0, 'nach dem Veroeffentlichen wird nicht neu geholt - die Kachel zeigte weiter die alte Zahl');
  assert.ok(before < saved, 'der alte Pfad muss gelesen sein, bevor savedWidgetConfig ueberschrieben wird');
  assert.ok(saved < reload && reload < rebuild, 'erst speichern, dann neu holen, dann zeichnen');
  // Derselbe Ablauf wie beim Speichern - der Zwilling, an dem die Luecke auffiel.
  const persist = functionBody(pageSource, 'async function persistWidgetConfig(nextConfig)');
  assert.match(persist, /await reloadIfQueryChanged\(previousQuery\);\s*rebuildDashboard\(widgetConfig\);/);
});
