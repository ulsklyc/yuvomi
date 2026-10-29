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
// Was ohne Streckung steht: Zusatzzeilen (U14, `data-fill-row`) zeigt erst
// applyRowFill, wenn die Packung der Kachel die Hoehe dafuer zuteilt.
const rowTitles = (html) => html.split('<div class="list-row event-item').slice(1)
  .filter((row) => !/^[^>]*data-fill-row/.test(row))
  .map((row) => /event-item__title">([^<]*)</.exec(row)?.[1]).filter((title) => title !== undefined);
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
    config.onSave({ querySelector: field, querySelectorAll: () => [] });
  };
  globalThis.__closeModal = () => true;
  try {
    // Ohne Kalender-Katalog (#2062): die Stufe ist hier die Frage, nicht die Auswahl.
    const result = dash.openWidgetOptions('calendar', current, { loadCalendars: async () => [] });
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

/* #2087: die Kachel folgt ihrer Groesse wie jede Liste (`listRowCap`). Vorher
 * zeigte eine 1x1-Kachel ihre Stufe - acht oder zwoelf Zeilen in einer
 * Rasterzeile, die die Nachbarn mitstreckte. */
const aheadMore = (html) => /widget-list-more"[^>]*>dashboard\.eventsMoreAhead</.test(html);

test('Kachel: 1x1 zeigt drei wie jede Liste, hoch die Stufe, 2x1 bleibt der Wochenstreifen (#2087)', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14), weekEvents: [] };
  for (const limit of [undefined, 8, 12]) {
    const options = limit === undefined ? {} : { limit };
    const small = dash.renderCalendarWidget(data, '1x1', options);
    assert.deepEqual(aheadRows(small), firstAhead(3), `1x1 mit ${limit ?? 5}`);
    assert.ok(aheadMore(small), `1x1 mit ${limit ?? 5}: was nicht passt, nennt die Fusszeile`);
    for (const size of ['1x2', '2x2']) {
      const tall = dash.renderCalendarWidget(data, size, options);
      assert.deepEqual(aheadRows(tall), firstAhead(limit ?? 5), `${size} mit ${limit ?? 5}`);
      assert.ok(!aheadMore(tall), `${size}: die Stufe ist ganz zu sehen, keine Fusszeile`);
    }
  }
  assert.equal(dash.calendarRowCap('1x1', 12), dash.listRowCap('1x1'), 'dieselbe Regel wie jede Liste');
  const strip = dash.renderCalendarWidget(data, '2x1', { limit: 12 });
  assert.match(strip, /week-strip/, '2x1 ist die Woche');
  assert.equal(rowTitles(strip).length, 0, 'und zeigt keine Liste, was immer gewaehlt ist');
}));

test('Kachel: 1x1 ohne Ueberhang traegt keine Fusszeile, und sie traegt keine Zahl', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  assert.ok(!aheadMore(dash.renderCalendarWidget({ upcomingEvents: tileEvents(3) }, '1x1', {})), 'drei von drei: nichts weiter');
  const four = dash.renderCalendarWidget({ upcomingEvents: tileEvents(4) }, '1x1', {});
  assert.ok(aheadMore(four));
  // Die Liste ist nach vorn offen: „+1 weitere" hiesse nur „einer mehr geladen".
  assert.doesNotMatch(four, /eventsMoreAhead\{/, 'die Fusszeile nennt keine Zahl');
}));

test('Kachel: 1x1 auf dem Telefon zeigt ebenfalls drei', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  assert.deepEqual(aheadRows(dash.renderCalendarWidget({ upcomingEvents: tileEvents(14) }, '1x1', { limit: 12 })), firstAhead(3));
}, { phone: true }));

test('Kachel: auf dem Telefon gilt dieselbe Zahl', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14) };
  assert.equal(dash.listRowCap('1x2'), 3, 'Vorbedingung: die Telefon-Buehne ist aktiv');
  assert.equal(aheadRows(dash.renderCalendarWidget(data, '1x2', { limit: 12 })).length, 12);
  assert.equal(aheadRows(dash.renderCalendarWidget(data, '1x2', {})).length, 5);
}, { phone: true }));

/* Beendete zaehlen innerhalb der Zeilen, nach dem Kommenden (#2087): zwei
 * obendrauf machten aus drei Zeilen fuenf. Ein Vergangenes verdraengt aber nie
 * ein Kommendes (#1449) - es nimmt nur, was frei bleibt. */
const endedRows = (html) => rowTitles(html).filter((title) => title.startsWith('Vorbei'));

test('Kachel: beendete von heute nehmen nur freie Zeilen und verdraengen nie ein Kommendes', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const full = dash.renderCalendarWidget({ upcomingEvents: tileEvents(14, { ended: 3 }) }, '1x2', { limit: 8 });
  assert.deepEqual(aheadRows(full), firstAhead(8), 'die Stufe gehoert dem Kommenden');
  assert.deepEqual(endedRows(full), [], 'eine volle Stufe laesst keinen Platz');
  assert.match(full, /dashboard\.eventsEndedMore\{&quot;count&quot;:3\}/, 'alle drei falten sich in die Zeile darueber');

  const evening = dash.renderCalendarWidget({ upcomingEvents: tileEvents(3, { ended: 3 }) }, '1x2', { limit: 8 });
  assert.deepEqual(aheadRows(evening), firstAhead(3));
  assert.deepEqual(endedRows(evening), ['Vorbei 09', 'Vorbei 10'], 'die zwei juengsten beendeten, zurueckgetreten darueber');
  assert.equal((evening.match(/event-item--ended/g) ?? []).length, 2);
  assert.match(evening, /event-list__earlier/, 'der dritte faltet sich in die Zeile darueber');

  const small = dash.renderCalendarWidget({ upcomingEvents: tileEvents(1, { ended: 3 }) }, '1x1', { limit: 12 });
  assert.equal(rowTitles(small).length, 3, '1x1: drei Zeilen insgesamt');
  assert.deepEqual(aheadRows(small), firstAhead(1));
  assert.deepEqual(endedRows(small), ['Vorbei 09', 'Vorbei 10']);

  const busy = dash.renderCalendarWidget({ upcomingEvents: tileEvents(5, { ended: 2 }) }, '1x1', {});
  assert.deepEqual(aheadRows(busy), firstAhead(3), '1x1 an einem vollen Tag: das Kommende zuerst');
  assert.deepEqual(endedRows(busy), []);
  assert.match(busy, /dashboard\.eventsEndedMore\{&quot;count&quot;:2\}/);
  assert.doesNotMatch(busy, /event-list__earlier/, 'die frueheren stehen in der Fusszeile, nicht in einer eigenen Zeile');
}));

/* Codex-Review zu PR #2117: eine volle 1x1-Kachel mit beendeten von heute trug
 * drei Zeilen, die Faltzeile „+N fruehere heute" UND die Fusszeile - eine
 * Zeile mehr als jede 1x1-Liste (drei Zeilen plus „+N weitere"), und damit
 * wieder eine gestreckte Nachbarzeile. Eine Kachel traegt hoechstens EINE
 * Zusatzzeile; stehen beide an, teilen sie sich die Fusszeile. */
const auxLines = (html) => (html.match(/class="(event-list__earlier|widget-list-more)"/g) ?? []).length;

test('Kachel: 1x1 voll und mit beendeten von heute traegt nur eine Zusatzzeile (Review #2117)', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  for (const ended of [1, 3]) {
    const html = dash.renderCalendarWidget({ upcomingEvents: tileEvents(5, { ended }) }, '1x1', {});
    assert.equal(rowTitles(html).length, 3, `${ended} beendet: drei Terminzeilen`);
    assert.equal(auxLines(html), 1, `${ended} beendet: eine Zusatzzeile wie jede 1x1-Liste`);
    const foot = /<p class="widget-list-more"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? '';
    assert.match(foot, new RegExp(`eventsEndedMore\\{&quot;count&quot;:${ended}\\}`), 'die Fusszeile nennt die frueheren');
    assert.match(foot, /eventsMoreAhead/, 'und dass weitere kommen');
  }
  // Ohne weitere Kommende bleibt die Faltzeile, wo sie war: ueber dem Kommenden.
  const rest = dash.renderCalendarWidget({ upcomingEvents: tileEvents(3, { ended: 3 }) }, '1x1', {});
  assert.equal(auxLines(rest), 1);
  assert.match(rest, /event-list__earlier/);
}));

/* Die Stufe ist in den hohen Groessen die Obergrenze der Liste (#2087), und
 * seit U1 b (DW-P1-3) ist die Kachel so hoch wie ihre Zeilen: 5/8/12 Termine
 * sind 5/8/12 Zeilen hoch - nicht 2/3/4 Rasterzeilen, die weniger Termine mit
 * Leere auffuellten. Darstellung, nicht Groesse: die Klasse bleibt. */
const wrapperOf = (html) => /<div class="widget-wrapper [^"]*"[^>]*data-widget-id="calendar"[^>]*>/.exec(html)?.[0] ?? '';
const tileAt = (size, options) => [{ id: 'calendar', visible: true, order: 0, size, ...(options ? { options } : {}) }];
const spurenOf = (html) => Number(/data-span-rows="(\d+)"/.exec(html)?.[1]);

test('Raster: die hohe Kalenderkachel ist so hoch wie ihre Termine, die Groesse bleibt (#2087, U1 b)', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => {
  const data = { upcomingEvents: tileEvents(14), weekEvents: [] };
  const wrap = (size, options) => wrapperOf(dash.renderDashboardLayout(tileAt(size, options), data, null, 'EUR'));
  const fuenf = spurenOf(wrap('1x2'));
  const acht = spurenOf(wrap('1x2', { limit: 8 }));
  const zwoelf = spurenOf(wrap('2x2', { limit: 12 }));
  assert.ok(fuenf > 0 && acht > fuenf && zwoelf > acht, `mehr Termine, hoehere Kachel: ${fuenf} / ${acht} / ${zwoelf}`);
  // Drei Zeilen mehr sind drei Zeilenhoehen mehr - nicht eine ganze Rasterzeile.
  const g = widgets.TILE_GEOMETRY;
  assert.ok(Math.abs((acht - fuenf) * g.unit - 3 * g.row) < g.unit, `8 statt 5: drei Zeilen mehr (${(acht - fuenf) * g.unit}px)`);
  assert.equal(spurenOf(wrap('1x2', { limit: 500 })), fuenf, 'ein Fremdwert geht durch die Klemme');
  for (const options of [{ limit: 8 }, { limit: 12 }]) {
    assert.match(wrap('1x2', options), /widget-size--1x2/, 'die gespeicherte Groesse bleibt die Klasse');
  }
  assert.doesNotMatch(wrap('1x2', { limit: 8 }), /data-list-rows/, 'die eigene Stufe-Spanne ist mit U1 b gegangen');
  // Weniger Termine als die Stufe: die Kachel ist kuerzer, nicht leerer.
  const wenige = spurenOf(wrapperOf(dash.renderDashboardLayout(tileAt('1x2', { limit: 12 }), { upcomingEvents: tileEvents(2), weekEvents: [] }, null, 'EUR')));
  assert.ok(wenige < fuenf, `zwei Termine bei Stufe 12 sind zwei Zeilen hoch (${wenige} < ${fuenf})`);
}));

/* Codex-Review zu PR #2117, neu gefasst mit U1 b: das Skelett sagt das Raster
 * voraus, das gleich kommt - auch die Hoehen. Kannte der Layout-Hinweis nur die
 * Groesse, stand die Kalenderkachel mit zwoelf Terminen im Skelett zu kurz und
 * wuchs beim Laden - die Nachbarn sprangen. Jetzt merkt er sich die Spuren,
 * die jede Kachel zuletzt belegt hat. */
const hintLayouts = await import('../public/utils/dashboard-layout-hint.js');
function withStorage(fn) {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  try {
    return fn(store);
  } finally {
    globalThis.localStorage = prev;
  }
}
const skeletonTiles = (html) => [...html.matchAll(/<div class="widget-wrapper (widget-size--[0-9x]+)"([^>]*)>/g)].map((m) => `${m[1]}${m[2]}`);

test('Skelett: jede Kachel steht schon in ihrer gezeichneten Hoehe da (Review #2117, U1 b)', inBrowser(THU_14_BERLIN, 'Europe/Berlin', () => withStorage((store) => {
  const cfg = [
    { id: 'calendar', visible: true, order: 0, size: '1x2', options: { limit: 12 } },
    { id: 'tasks', visible: true, order: 1, size: '1x1' },
    { id: 'notes', visible: false, order: 2, size: '1x2' },
  ];
  const spans = { calendar: 182, tasks: 66 };
  hintLayouts.rememberLayoutHint(cfg, '/dashboard?events_limit=12', (w) => spans[w.id] ?? null);
  assert.deepEqual(skeletonTiles(dash.renderDashboardSkeleton()), ['widget-size--1x2 style="--tile-rows: 182"', 'widget-size--1x1 style="--tile-rows: 66"']);
  // Der Aufbau merkt sich, was er gezeichnet hat (drawnSpanOf in rememberGridHint).
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /rememberLayoutHint\(drawn, dashboardQuery\(cfg\), drawnSpanOf\)/);

  // Alte Eintraege (vor U1 b, auch die Array-Form und die Listenstufe aus #2087)
  // sagen weiter die Groessen voraus - die Hoehe kommt dann aus der Groesse.
  store.set('yuvomi-dash-layout-hint', JSON.stringify({ sizes: ['1x2', '2x1'], query: '/dashboard', listRows: [12, 0] }));
  assert.deepEqual(skeletonTiles(dash.renderDashboardSkeleton()), ['widget-size--1x2', 'widget-size--2x1']);
  store.set('yuvomi-dash-layout-hint', JSON.stringify(['2x2']));
  assert.deepEqual(skeletonTiles(dash.renderDashboardSkeleton()), ['widget-size--2x2']);
  // Der Eintrag ist von der Seite aus beschreibbar: nur eine ganze Zahl in Grenzen wird zum Stil.
  store.set('yuvomi-dash-layout-hint', JSON.stringify({ sizes: ['1x2', '1x2', '1x2', '1x2'], spans: ['"><b>', 7.5, 5000, 40] }));
  assert.deepEqual(skeletonTiles(dash.renderDashboardSkeleton()), ['widget-size--1x2', 'widget-size--1x2', 'widget-size--1x2', 'widget-size--1x2 style="--tile-rows: 40"']);
  store.set('yuvomi-dash-layout-hint', JSON.stringify({ sizes: ['1x2'], spans: [12, 8] }));
  assert.deepEqual(skeletonTiles(dash.renderDashboardSkeleton()), ['widget-size--1x2'], 'Hoehen nur passend zu den Groessen');
})));

test('Raster: dashboard.css kennt keine Stufen-Spannen mehr - die Hoehe kommt aus --tile-rows (U1 b)', () => {
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-list-rows=/, 'keine Regel liest mehr die Listenstufe');
  assert.match(css, /grid-row-end:\s*span calc\(var\(--tile-rows, var\(--tile-size-rows\)\) \+ var\(--tile-gap-rows\)\)/,
    'die Spanne jeder Kachel kommt aus ihren Daten');
});

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

/* Die Wand hat ihren eigenen Deckel und liest weder Groesse noch Stufe noch
 * die Telefon-Buehne (#2087 laesst sie unberuehrt). */
test('Wand: vier Zeilen, mit und ohne Telefon-Buehne dieselbe Flaeche (#2087)', async () => {
  const today = Array.from({ length: 12 }, (_, i) => ev(i + 1, `Heute ${pad(i + 8)}`, `2026-09-24T${pad(i + 8)}:00`, `2026-09-24T${pad(i + 8)}:30`));
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: 50 + i, title: `Aufgabe ${i}`, priority: 'high', status: 'open', due_date: '2026-09-24', assigned_users: [] }));
  const data = { upcomingEvents: today, urgentTasks: tasks, openTaskCount: 12, users: [] };
  let wide;
  let narrow;
  await inBrowser('2026-09-24T04:00:00Z', 'Europe/Berlin', () => {
    assert.equal(dash.WALL_ROW_CAP, 4, 'der Deckel der Wand');
    assert.equal(dash.buildTodayCockpitModel(data, [], { cap: dash.WALL_ROW_CAP, groupOverdue: false }).rows.length, 4);
    wide = dash.renderWallSurface(data, null, { now: new Date() });
  })();
  await inBrowser('2026-09-24T04:00:00Z', 'Europe/Berlin', () => {
    assert.equal(dash.listRowCap('1x2'), 3, 'Vorbedingung: die Telefon-Buehne ist aktiv');
    narrow = dash.renderWallSurface(data, null, { now: new Date() });
  }, { phone: true })();
  assert.match(wide, /wall__program/, 'Reichweite: die Wand ist gebaut');
  // Seit R24 fuehrt auf der Wand die Leiste wie im Cockpit (wallTimelineOptions):
  // die vier Zeilen sind die ersten Termine des Tages, die Aufgaben stehen
  // dahinter in „+N weitere".
  const rows = [...wide.matchAll(/<li class="wall-row wall-row--(\w+)"[\s\S]*?wall-row__title">([^<]*)</g)]
    .filter(([, tone]) => tone !== 'shopping' && tone !== 'state').map(([, , title]) => title);
  assert.deepEqual(rows, ['Heute 08', 'Heute 09', 'Heute 10', 'Heute 11'], 'die Wand zeigt vier Zeilen, nicht drei und nicht fuenf');
  assert.equal(narrow, wide, 'die Telefon-Buehne aendert an der Wand nichts');
});

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
  // Gefragt wird nach dem Pfad, der WIRKLICH abgerufen wurde: seit #1817 haengt
  // die Wand `audience=household` an (`overviewRequest`), und deren Zahlen sind
  // die des Haushalts, nicht die der Person - sie duerfen nie in den Speicher
  // der Navigations-Badges. Dass die Regel sie als gefiltert wertet, misst
  // test:wall-tasks.
  assert.equal(call[1], "dashboardQueryFiltersCounts(overviewRequest(layoutHintQuery('/dashboard')))");
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
