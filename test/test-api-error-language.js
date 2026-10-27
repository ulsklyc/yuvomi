/**
 * Test: Die Saetze der API sprechen Englisch, ueber das Budget hinaus (#1695)
 * Zweck: `error` ist Teil der zugesagten `/api/v1`-Oberflaeche. Die App zeigt
 *        ihn nicht mehr an (sie liest `reason` und hat eigene Saetze), ein
 *        API-Client aber schon - und bekam ausserhalb des Budgets noch
 *        hunderte deutsche Saetze ("timezone_hint_dismissed muss true oder
 *        false sein.", "Interner Fehler") und Mischsaetze ("Titel is
 *        required."). Das Budget haelt test:budget-error-language (#1694).
 *
 *        Dieselbe Regel (test/error-language.js), zwei Beine wie dort:
 *          1. RATCHET ueber alle Routen-Dateien: was eine Datei an Saetzen
 *             und Feldnamen Richtung Antwort hinausreicht, wird mit der Regel
 *             gelesen, und die Zahl der deutschen Stellen je Datei steht in
 *             GERMAN_LEFT. Sie darf nur sinken: eine neue deutsche Stelle ist
 *             rot, und eine Datei, die weniger hat als eingetragen, auch, bis
 *             die Zahl gesenkt ist. Ein Modul, das umgestellt ist, faellt aus
 *             der Liste - fuer es gilt dann 0.
 *          2. Je umgestelltes Modul fahren die echten Routen als Programm:
 *             jede gefuehrte Anfrage muss abgelehnt werden, und ihr Satz darf
 *             kein deutsches Wort tragen. Das Lesen der Dateien allein waere
 *             ein Textguard; der Programmlauf sieht auch einen Satz, den ein
 *             Helfer baut.
 *
 *        GEGENPROBE (26.10.2026): gegen den Stand vor der Umstellung der
 *        Preferences rot - Bein 1 meldet `server/routes/preferences.js: 59
 *        (erlaubt 0)`, Bein 2 nennt jede gefuehrte Anfrage mit ihrem
 *        deutschen Wort. Ebenso fuer die Google- und Outlook-Konten
 *        (calendar/google.js, calendar/outlook.js): `google.js: 23`,
 *        `outlook.js: 3`, und jede der 19 gefuehrten Anfragen deutsch.
 *        Ebenso fuer die Erinnerungen (reminders.js): `reminders.js: 10
 *        (erlaubt 0)`, und Bein 2 nennt jede Absage mit Satz der Route.
 *        Ebenso fuer die Notizen (notes.js): `notes.js: 14 (erlaubt 0)`, und
 *        Bein 2 nennt jede der 13 gefuehrten Absagen deutsch.
 *        Ebenso fuer die Schnellzugriffe (quick-links.js): `quick-links.js: 10
 *        (erlaubt 0)`, und Bein 2 nennt die fuenf deutschen Absagen.
 *        Ebenso fuer das Inventar (inventory/items.js 9, item-dates.js 5,
 *        service-log.js 6): Bein 2 nennt 20 deutsche Absagen, darunter
 *        Feldnamen, die Bein 1 nicht liest (`idParam(..., 'Buchung-ID')`,
 *        `date(..., 'Datum')`, ein Satz aus einem `return` im Helfer).
 *        Ebenso fuer die Kontakte (contacts.js): `contacts.js: 13 (erlaubt 0)`,
 *        und Bein 2 nennt 12 deutsche Absagen - elf davon Feldnamen, die
 *        Bein 1 nicht liest (`limitedStr(..., 'Telefon')`, `date(..., 'Geburtstag')`).
 *        Ebenso fuer die Gesundheit (health/*.js, 32 Stellen in acht Dateien):
 *        Bein 1 nennt jede Datei, Bein 2 nennt alle 20 gefuehrten Absagen deutsch.
 *        Ebenso fuer die Kalender-Abos, die Apple-Anbindung, den Feed, das Lesen
 *        und die Kalenderziele (calendar/{apple,feed,helpers,read,subscriptions}.js,
 *        46 Stellen): Bein 2 nennt 26 der 28 gefuehrten Absagen deutsch; "url:
 *        Pflichtfeld." sah die Regel erst mit diesem Wort.
 *        Ebenso fuer Einkauf, Aufgaben, Push und Wetter (shopping.js 19 mit
 *        "Menge" in der Regel, tasks.js 4, push.js 3, weather.js 2): Bein 2
 *        nennt alle 29 gefuehrten Absagen deutsch.
 *        Ebenso fuer Essensplan, Vorrat und Rezepte (meals.js 34, pantry.js 5,
 *        recipes.js 2): Bein 2 nennt 30 der 38 gefuehrten Absagen deutsch.
 *
 * Ausführen: npm run test:api-error-language
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { germanIn, outboundLiterals } from './error-language.js';

const ROUTES = new URL('../server/routes/', import.meta.url);

/**
 * Deutsche Stellen je Routen-Datei, Stand 26.10.2026. NUR SENKEN: wer ein
 * Modul umstellt, streicht seine Zeile - der Test verlangt es.
 */
const GERMAN_LEFT = new Map([
]);

function routeFiles(dir = ROUTES, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) return routeFiles(new URL(`${name}/`, dir), `${prefix}${name}/`);
    return name.endsWith('.js') ? [{ rel: `${prefix}${name}`, url }] : [];
  });
}

/** Datei -> ihre deutschen Stellen. */
function germanByFile() {
  const out = new Map();
  for (const { rel, url } of routeFiles()) {
    const hits = outboundLiterals(readFileSync(url, 'utf8'))
      .map((lit) => ({ ...lit, word: germanIn(lit.text) }))
      .filter((lit) => lit.word);
    if (hits.length) out.set(rel, hits);
  }
  return out;
}

test('die Regel erkennt die alten Saetze der uebrigen Module und laesst englische durch', () => {
  for (const old of [
    'Interner Fehler',
    'timezone_hint_dismissed muss true oder false sein.',
    'Ungültige Zeitzone. Erwartet wird eine IANA-Zone wie "Europe/Berlin".',
    'Notiz nicht gefunden',
    'Kontakt nicht gefunden',
    'Name ist erforderlich',
    'Kilometerstand darf nicht negativ sein.',
    'Inhalt is required.',
    'Fehler beim Abrufen der Länderliste.',
    'calendar_default_target: maximal 300 Zeichen',
    'Unbekannte Nutzer-ID.',
    'target_google_calendar_id: zu lang.',
    'Menge may be at most 100 characters long.',
    'url: Pflichtfeld.',
    'Telefon is too long.',
    'Geburtstag must be a valid date.',
  ]) assert.ok(germanIn(old), `nicht erkannt: ${old}`);
  for (const fine of [
    'Internal server error.',
    'timezone_hint_dismissed must be true or false.',
    'Invalid time zone. Expected an IANA zone such as "Europe/Berlin".',
    'Invalid region.',
    'Admin access required.',
    'Invalid country code (2 capital letters, e.g. DE).',
    'calendar_default_target may be at most 300 characters long.',
    'phone may be at most 50 characters long.',
  ]) assert.equal(germanIn(fine), null, `faelschlich erkannt: ${fine}`);
});

// ── Bein 1: der Ratchet ueber alle Routen-Dateien ────────────────────────────
test('keine Routen-Datei reicht mehr deutsche Saetze hinaus als eingetragen', () => {
  const found = germanByFile();
  const grown = [];
  for (const [rel, hits] of found) {
    const allowed = GERMAN_LEFT.get(rel) ?? 0;
    if (hits.length > allowed) {
      grown.push(`server/routes/${rel}: ${hits.length} (erlaubt ${allowed})\n    `
        + hits.map((h) => `:${h.line} "${h.text.slice(0, 80)}" - deutsch: "${h.word}"`).join('\n    '));
    }
  }
  assert.deepEqual(grown, [], `deutsche Saetze oder Feldnamen ueber der Liste:\n  ${grown.join('\n  ')}`);
});

test('die Liste der deutschen Stellen schrumpft nur', () => {
  const found = germanByFile();
  const stale = [];
  for (const [rel, allowed] of GERMAN_LEFT) {
    const now = found.get(rel)?.length ?? 0;
    if (now < allowed) stale.push(`${rel}: ${now} statt ${allowed} - Zahl senken (bei 0 die Zeile streichen)`);
  }
  assert.deepEqual(stale, [], `GERMAN_LEFT ist veraltet:\n  ${stale.join('\n  ')}`);
});

test('der Leser findet die Saetze ueberhaupt', () => {
  const files = routeFiles();
  assert.ok(files.length > 60, `nur ${files.length} Routen-Dateien gefunden`);
  let read = 0;
  for (const { url } of files) read += outboundLiterals(readFileSync(url, 'utf8')).length;
  assert.ok(read > 1500, `nur ${read} Saetze gelesen - der Leser greift nicht mehr`);
  // Die Unterordner (routes/calendar/, routes/health/ ...) zaehlen mit.
  assert.ok(files.some(({ rel }) => rel === 'calendar/google.js'), 'Unterordner werden nicht gelesen');
});

// ── Bein 2: die umgestellten Module als Programm ─────────────────────────────

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const holidays = await import('../server/services/holidays.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;
const MEMBER = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('member','Member','x','member')").run().lastInsertRowid;

const actor = { userId: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.userId;
  req.authRole = actor.role;
  req.session = { userId: actor.userId };
  next();
});
app.use('/preferences', preferencesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.close(); holidays.__setFetchImpl(null); });

async function call(method, route, body, { userId = ADMIN, role = 'admin' } = {}) {
  actor.userId = userId;
  actor.role = role;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: res.status, body: json };
}

function assertRefusedInEnglish(seen) {
  // Erst die Vorbedingung, dann die Aussage: eine Anfrage, die durchgeht oder
  // ohne Satz abgelehnt wird, hat nichts gemessen.
  const notRefused = seen.filter((s) => s.status < 400 || typeof s.error !== 'string' || !s.error);
  assert.deepEqual(notRefused, [], 'jede gefuehrte Anfrage wird mit einem Satz abgelehnt');
  const german = seen
    .map((s) => ({ ...s, word: germanIn(s.error) }))
    .filter((s) => s.word)
    .map((s) => `${s.label} (${s.status}): "${s.error.slice(0, 120)}" - deutsch: "${s.word}"`);
  assert.deepEqual(german, [], `Absagen mit deutschem Wortlaut:\n  ${german.join('\n  ')}`);
}

test('keine Absage der Preferences-Routen traegt deutschen Wortlaut', async () => {
  const seen = [];
  const run = async (label, method, route, body, who) => {
    const r = await call(method, route, body, who);
    seen.push({ label, status: r.status, error: r.body?.error ?? null });
  };
  const put = (label, body, who) => run(label, 'PUT', '/preferences', body, who);
  const member = { userId: MEMBER, role: 'member' };
  const long = 'x'.repeat(400);

  await put('schedule-templates', { schedule_hidden_templates: 'nope' });
  await put('zone-hint', { timezone_hint_dismissed: 'yes' });
  await put('meal-types', { visible_meal_types: 'nope' });
  await put('meal-types-empty', { visible_meal_types: ['nope'] });
  await put('meal-names', { meal_type_names: 'nope' });
  await put('meal-name-type', { meal_type_names: { breakfast: 5 } });
  await put('meal-name-long', { meal_type_names: { breakfast: long } });
  await put('currency', { currency: 'XXX' });
  await put('date-format', { date_format: 'nope' });
  await put('week-start', { week_start: 'nope' });
  await put('budget-mode', { budget_mode: 'nope' });
  await put('region', { region: '!!' });
  await put('timezone', { timezone: 'Mars/Olympus' });
  await put('language', { language: 'xx' });
  await put('widgets', { dashboard_widgets: 'nope' });
  await put('widgets-entries', { dashboard_widgets: [42] });
  await put('glance', { dashboard_today_glance: 'nope' });
  await put('widgets-default', { dashboard_widgets_default: 'nope' });
  await put('widgets-default-entries', { dashboard_widgets_default: [42] });
  await put('glance-default', { dashboard_today_glance_default: 'nope' });
  await put('disabled-modules', { disabled_modules: 'nope' });
  await put('hidden-modules', { hidden_modules: 'nope' });
  await put('module-order', { module_order: 'nope' });
  await put('mobile-nav', { mobile_nav_order: 'nope' });
  await put('reminders', { calendar_default_reminders: 'nope' });
  await put('reminders-offset', { calendar_default_reminders: [7] });
  await put('reminders-many', { calendar_default_reminders: [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080] });
  await put('calendar-target', { calendar_default_target: 5 });
  await put('calendar-target-long', { calendar_default_target: long });
  await put('calendar-target-shape', { calendar_default_target: 'nope' });
  await put('tasks-target', { tasks_default_target: 5 });
  await put('tasks-target-long', { tasks_default_target: long });
  await put('tasks-target-shape', { tasks_default_target: 'google:primary' });
  await put('weather-provider', { weather_provider: 'nope' });
  await put('weather-lat', { weather_lat: 'abc' });
  await put('weather-lon', { weather_lon: 999 });
  await put('weather-units', { weather_units: 'nope' });
  await put('weather-auto', { weather_auto_locate: 'nope' });
  await put('weather-user', { weather_user: 'nope' });
  await put('weather-user-lat', { weather_user: { lat: 'abc' } });
  await put('weather-user-lon', { weather_user: { lon: 999 } });
  await put('weather-user-units', { weather_user: { units: 'nope' } });
  await put('weather-user-auto', { weather_user: { auto_locate: 'nope' } });
  await put('weather-user-anon', { weather_user: {} }, { userId: null, role: 'member' });
  await put('holiday-country', { holiday_country: 'de' });
  await put('holiday-subdivision', { holiday_subdivision: 'nope' });
  await put('holiday-group', { holiday_group: 'nope' });
  await put('holiday-public-color', { holiday_public_color: 'red' });
  await put('holiday-school-color', { holiday_school_color: 'red' });
  await put('member-default', { dashboard_widgets_default: [] }, member);
  await put('member-weather', { weather_provider: null }, member);
  await run('subdivisions-country', 'GET', '/preferences/holidays/subdivisions/de');
  await run('groups-country', 'GET', '/preferences/holidays/groups/de');
  await run('groups-sub-country', 'GET', '/preferences/holidays/groups/de/DE-BY');
  await run('groups-sub-code', 'GET', '/preferences/holidays/groups/DE/nope');
  await run('sync-member', 'POST', '/preferences/holidays/sync', {}, member);

  // Die Feiertags-Quelle faellt aus: 502 mit dem Satz der Route. Die
  // Laenderliste hat einen eingebauten Rueckfall und kommt trotzdem; ihr Satz
  // steht nur in Bein 1.
  holidays.__setFetchImpl(async () => { throw new Error('offline'); });
  await run('subdivisions-down', 'GET', '/preferences/holidays/subdivisions/ZZ');
  await run('groups-down', 'GET', '/preferences/holidays/groups/ZZ');
  await run('groups-sub-down', 'GET', '/preferences/holidays/groups/ZZ/ZZ-AA');
  holidays.__setFetchImpl(null);

  assertRefusedInEnglish(seen);
});

test('keine Absage der Kalender-Konten (Google, Outlook) traegt deutschen Wortlaut', async () => {
  const { default: calendarRouter } = await import('../server/routes/calendar.js');
  const { movedCandidatesLimit } = await import('../server/services/sync-assignment.js');
  const calApp = express();
  calApp.use(express.json({ limit: '10mb' }));
  calApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  calApp.use('/calendar', calendarRouter);
  const calServer = calApp.listen(0, '127.0.0.1');
  const calUrl = await new Promise((r) => calServer.on('listening', () => r(`http://127.0.0.1:${calServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${calUrl}${route}`, { method, headers, body: payload, redirect: 'manual' });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const ext = '/calendar/external-calendars';
    const backfill = `${ext}/default-assignee-backfill`;
    const ok = { source: 'google', external_id: 'cal-1' };

    await run('google-callback-code', 'GET', '/calendar/google/callback');
    await run('google-calendar-id', 'PATCH', '/calendar/google/calendars', {});
    await run('google-enabled', 'PATCH', '/calendar/google/calendars', { calendarId: 'c', enabled: 'yes' });
    await run('google-readonly', 'PUT', '/calendar/google/readonly', { readonly: 'yes' });
    await run('ext-source', 'PATCH', ext, { ...ok, source: 'nope' });
    await run('ext-id', 'PATCH', ext, { ...ok, external_id: ' ' });
    await run('ext-assignee', 'PATCH', ext, { ...ok, default_assignee_user_id: 'abc' });
    await run('ext-assignee-unknown', 'PATCH', ext, { ...ok, default_assignee_user_id: 987654 });
    await run('ext-not-synced', 'PATCH', ext, { ...ok, default_assignee_user_id: null });
    await run('backfill-cursor', 'GET', `${backfill}?moved_after=nope`);
    await run('backfill-count', 'POST', backfill, {});
    await run('backfill-token', 'POST', backfill, { expected_count: 0, expected_token: 'nope' });
    await run('backfill-moves', 'POST', backfill, { expected_count: 0, moves: 'nope' });
    await run('backfill-move-item', 'POST', backfill, { expected_count: 0, moves: [{ event_id: 'x' }] });
    await run('backfill-moves-many', 'POST', backfill, {
      expected_count: 0,
      moves: Array.from({ length: movedCandidatesLimit.max + 1 }, (_, i) => ({ event_id: i + 1, from_user_id: 1, to_user_id: 1 })),
    });
    await run('backfill-changed', 'POST', backfill, { expected_count: 5 });
    await run('outlook-callback-code', 'GET', '/calendar/outlook/callback');
    await run('outlook-calendar-id', 'PATCH', '/calendar/outlook/accounts/1/calendars', {});
    await run('outlook-enabled', 'PATCH', '/calendar/outlook/accounts/1/calendars', { calendarId: 'c', enabled: 'yes' });

    assertRefusedInEnglish(seen);
  } finally {
    calServer.close();
  }
});

test('keine Absage der Erinnerungs-Routen traegt deutschen Wortlaut', async () => {
  const { default: remindersRouter } = await import('../server/routes/reminders.js');
  const scopes = { current: null };
  const remApp = express();
  remApp.use(express.json());
  remApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.authScopes = scopes.current;
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  remApp.use('/reminders', remindersRouter);
  const remServer = remApp.listen(0, '127.0.0.1');
  const remUrl = await new Promise((r) => remServer.on('listening', () => r(`http://127.0.0.1:${remServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body, tokenScopes = null) => {
      scopes.current = tokenScopes;
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${remUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const task = db.prepare("INSERT INTO tasks (title, created_by) VALUES ('Probe', ?)").run(ADMIN).lastInsertRowid;
    const forTask = `/reminders?entity_type=task&entity_id=${task}`;
    const notesOnly = ['notes:read'];

    await run('all-params', 'GET', '/reminders/all');
    await run('all-module', 'GET', `/reminders/all?entity_type=task&entity_id=${task}`, undefined, notesOnly);
    await run('get-params', 'GET', '/reminders');
    await run('get-module', 'GET', forTask, undefined, notesOnly);
    await run('post-empty', 'POST', '/reminders', {});
    await run('post-derived', 'POST', '/reminders', { entity_type: 'pantry_item', entity_id: 1, remind_at: '2026-11-01T09:00:00' });
    await run('post-module', 'POST', '/reminders', { entity_type: 'task', entity_id: task, remind_at: '2026-11-01T09:00:00' }, notesOnly);
    await run('post-target', 'POST', '/reminders', { entity_type: 'task', entity_id: 987654, remind_at: '2026-11-01T09:00:00' });
    await run('put-params', 'PUT', '/reminders', { remind_ats: [] });
    await run('put-derived', 'PUT', '/reminders?entity_type=pantry_item&entity_id=1', { remind_ats: [] });
    await run('put-module', 'PUT', forTask, { remind_ats: [] }, notesOnly);
    await run('put-array', 'PUT', forTask, { remind_ats: 'nope' });
    await run('put-entry', 'PUT', forTask, { remind_ats: ['nope'] });
    await run('put-many', 'PUT', forTask, { remind_ats: [1, 2, 3, 4, 5, 6].map((d) => `2026-11-0${d}T09:00:00`) });
    await run('dismiss-id', 'PATCH', '/reminders/abc/dismiss', {});
    await run('dismiss-gone', 'PATCH', '/reminders/987654/dismiss', {});
    await run('delete-id', 'DELETE', '/reminders/abc');
    await run('delete-gone', 'DELETE', '/reminders/987654');
    await run('delete-params', 'DELETE', '/reminders');
    await run('delete-derived', 'DELETE', '/reminders?entity_type=pantry_item&entity_id=1');
    await run('delete-module', 'DELETE', forTask, undefined, notesOnly);

    assertRefusedInEnglish(seen);
  } finally {
    remServer.close();
  }
});

test('keine Absage der Notizen traegt deutschen Wortlaut', async () => {
  const { default: notesRouter } = await import('../server/routes/notes.js');
  const notesApp = express();
  notesApp.use(express.json());
  notesApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  notesApp.use('/notes', notesRouter);
  const notesServer = notesApp.listen(0, '127.0.0.1');
  const notesUrl = await new Promise((r) => notesServer.on('listening', () => r(`http://127.0.0.1:${notesServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${notesUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const note = db.prepare("INSERT INTO notes (content, created_by) VALUES ('Liste\n- [ ] Milch', ?)").run(ADMIN).lastInsertRowid;
    const long = 'x'.repeat(100000);

    await run('post-content', 'POST', '/notes', {});
    await run('post-content-long', 'POST', '/notes', { content: long });
    await run('post-title-long', 'POST', '/notes', { content: 'C', title: long });
    await run('post-color', 'POST', '/notes', { content: 'C', color: 'red' });
    await run('put-content-long', 'PUT', `/notes/${note}`, { content: long });
    await run('put-title', 'PUT', `/notes/${note}`, { title: long });
    await run('put-color', 'PUT', `/notes/${note}`, { color: 'red' });
    await run('check-line', 'PATCH', `/notes/${note}/check`, { line: -1, checked: true });
    await run('check-state', 'PATCH', `/notes/${note}/check`, { line: 1, checked: 'yes' });
    await run('check-expect', 'PATCH', `/notes/${note}/check`, { line: 1, checked: true, expect: 5 });
    await run('check-stale', 'PATCH', `/notes/${note}/check`, { line: 1, checked: true, expect: '- [ ] Brot' });
    await run('check-range', 'PATCH', `/notes/${note}/check`, { line: 9, checked: true });
    await run('check-not-item', 'PATCH', `/notes/${note}/check`, { line: 0, checked: true });

    assertRefusedInEnglish(seen);
  } finally {
    notesServer.close();
  }
});

test('keine Absage der Schnellzugriffe traegt deutschen Wortlaut', async () => {
  const { default: quickLinksRouter } = await import('../server/routes/quick-links.js');
  const who = { userId: ADMIN, role: 'admin' };
  const qlApp = express();
  qlApp.use(express.json());
  qlApp.use((req, _res, next) => {
    req.authUserId = who.userId;
    req.authRole = who.role;
    req.session = { userId: who.userId, role: who.role };
    next();
  });
  qlApp.use('/quick-links', quickLinksRouter);
  const qlServer = qlApp.listen(0, '127.0.0.1');
  const qlUrl = await new Promise((r) => qlServer.on('listening', () => r(`http://127.0.0.1:${qlServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body, as = { userId: ADMIN, role: 'admin' }) => {
      Object.assign(who, as);
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${qlUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const shared = db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('S','https://s.example/','all',?,0)").run(ADMIN).lastInsertRowid;
    const member = { userId: MEMBER, role: 'member' };

    await run('post-name', 'POST', '/quick-links', { url: 'https://a.example/' });
    await run('post-url', 'POST', '/quick-links', { name: 'A' });
    await run('post-color', 'POST', '/quick-links', { name: 'A', url: 'https://a.example/', color: 'red' });
    await run('order-ids', 'PUT', '/quick-links/order', { ids: 'nope' });
    await run('put-gone', 'PUT', '/quick-links/987654', { name: 'X' });
    await run('put-foreign', 'PUT', `/quick-links/${shared}`, { name: 'X' }, member);
    await run('put-url', 'PUT', `/quick-links/${shared}`, { url: 'javascript:alert(1)' });
    await run('delete-gone', 'DELETE', '/quick-links/987654');
    await run('delete-foreign', 'DELETE', `/quick-links/${shared}`, undefined, member);

    assertRefusedInEnglish(seen);
  } finally {
    qlServer.close();
  }
});

test('keine Absage des Inventars traegt deutschen Wortlaut', async () => {
  const { default: inventoryRouter } = await import('../server/routes/inventory/index.js');
  const invApp = express();
  invApp.use(express.json({ limit: '10mb' }));
  invApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  invApp.use('/inventory', inventoryRouter);
  const invServer = invApp.listen(0, '127.0.0.1');
  const invUrl = await new Promise((r) => invServer.on('listening', () => r(`http://127.0.0.1:${invServer.address().port}`)));
  try {
    const seen = [];
    const call = async (method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${invUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      return { status: res.status, body: json };
    };
    const run = async (label, method, route, body) => {
      const r = await call(method, route, body);
      seen.push({ label, status: r.status, error: r.body?.error ?? null });
    };
    const car = await call('POST', '/inventory/items', {
      name: 'Auto', category: 'vehicles', odometer: 50000, odometer_unit: 'km', odometer_on: '2026-09-01',
    });
    assert.equal(car.status, 201, 'Vorbedingung: das Fahrzeug wird angelegt');
    const id = car.body.data.id;
    const item = (extra) => ({ name: 'Ding', ...extra });
    const date = (extra) => ({ name: 'Ding', tracked_dates: [{ label: 'TÜV', date: '2027-01-01', ...extra }] });

    await run('name', 'POST', '/inventory/items', {});
    await run('category', 'POST', '/inventory/items', item({ category: 'nope' }));
    await run('location', 'POST', '/inventory/items', item({ location_id: 'abc' }));
    await run('purchase-date', 'POST', '/inventory/items', item({ purchase_date: 'nope' }));
    await run('price', 'POST', '/inventory/items', item({ purchase_price: -1 }));
    await run('price-type', 'POST', '/inventory/items', item({ purchase_price: 'abc' }));
    await run('warranty', 'POST', '/inventory/items', item({ warranty_months: 601 }));
    await run('odometer', 'POST', '/inventory/items', item({ category: 'vehicles', odometer: -5 }));
    await run('odometer-unit', 'POST', '/inventory/items', item({ category: 'vehicles', odometer: 5, odometer_unit: 'nope' }));
    await run('odometer-on', 'POST', '/inventory/items', item({ category: 'vehicles', odometer: 5, odometer_on: 'nope' }));
    await run('condition', 'POST', '/inventory/items', item({ condition: 'nope' }));
    await run('status', 'POST', '/inventory/items', item({ status: 'nope' }));
    await run('entry-id', 'POST', '/inventory/items', item({ entry_id: 'abc' }));
    await run('date-label', 'POST', '/inventory/items', date({ label: '' }));
    await run('date-date', 'POST', '/inventory/items', date({ date: 'nope' }));
    await run('date-offset', 'POST', '/inventory/items', date({ reminder_offset_days: 400 }));
    await run('date-interval', 'POST', '/inventory/items', date({ interval_months: 0 }));
    await run('date-distance', 'POST', '/inventory/items', date({ interval_distance: -1 }));
    await run('dates-many', 'POST', '/inventory/items', {
      name: 'Ding', tracked_dates: Array.from({ length: 11 }, (_, i) => ({ label: `F${i}`, date: '2027-01-01' })),
    });
    await run('item-id', 'GET', '/inventory/items/abc');
    await run('link-entry', 'POST', `/inventory/items/${id}/entries`, { entry_id: 'abc' });
    await run('link-role', 'POST', `/inventory/items/${id}/entries`, { entry_id: 1, role: 'nope' });
    await run('link-share', 'POST', `/inventory/items/${id}/entries`, { entry_id: 1, amount_share: -1 });
    await run('unlink-entry', 'DELETE', `/inventory/items/${id}/entries/abc`);
    await run('complete-date', 'POST', `/inventory/items/${id}/dates/abc/complete`, {});
    await run('log-label', 'POST', `/inventory/items/${id}/service-log`, { performed_on: '2026-10-01' });
    await run('log-date', 'POST', `/inventory/items/${id}/service-log`, { label: 'Ölwechsel' });
    await run('log-odometer', 'POST', `/inventory/items/${id}/service-log`, { label: 'Ölwechsel', performed_on: '2026-10-01', odometer: -1 });
    await run('log-regression', 'POST', `/inventory/items/${id}/service-log`, { label: 'Ölwechsel', performed_on: '2026-10-01', odometer: 40000 });
    await run('log-id', 'PUT', `/inventory/items/${id}/service-log/abc`, { label: 'X', performed_on: '2026-10-01' });
    await run('entry-items-id', 'GET', '/inventory/entries/abc/items');

    assertRefusedInEnglish(seen);
  } finally {
    invServer.close();
  }
});

test('keine Absage der Kontakte traegt deutschen Wortlaut', async () => {
  const { default: contactsRouter } = await import('../server/routes/contacts.js');
  const cApp = express();
  cApp.use(express.json());
  cApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  cApp.use('/contacts', contactsRouter);
  const cServer = cApp.listen(0, '127.0.0.1');
  const cUrl = await new Promise((r) => cServer.on('listening', () => r(`http://127.0.0.1:${cServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${cUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const family = db.prepare("INSERT INTO contacts (name, family_user_id) VALUES ('Member', ?)").run(MEMBER).lastInsertRowid;
    const long = 'x'.repeat(20000);

    await run('post-name', 'POST', '/contacts', {});
    await run('post-first-name', 'POST', '/contacts', { firstName: long });
    await run('post-last-name', 'POST', '/contacts', { name: 'A', lastName: long });
    await run('post-middle-name', 'POST', '/contacts', { name: 'A', middleName: long });
    await run('post-name-prefix', 'POST', '/contacts', { name: 'A', namePrefix: long });
    await run('post-name-suffix', 'POST', '/contacts', { name: 'A', nameSuffix: long });
    await run('post-phone', 'POST', '/contacts', { name: 'A', phone: long });
    await run('post-email', 'POST', '/contacts', { name: 'A', email: long });
    await run('post-address', 'POST', '/contacts', { name: 'A', address: long });
    await run('post-notes', 'POST', '/contacts', { name: 'A', notes: long });
    await run('post-birthday', 'POST', '/contacts', { name: 'A', birthday: 'nope' });
    await run('post-category', 'POST', '/contacts', { name: 'A', category: 'nope' });
    await run('put-birthday', 'PUT', `/contacts/${family}`, { birthday: 'nope' });
    await run('put-phone', 'PUT', `/contacts/${family}`, { phone: long });
    await run('put-gone', 'PUT', '/contacts/987654', { name: 'X' });
    await run('delete-family', 'DELETE', `/contacts/${family}`);
    await run('delete-gone', 'DELETE', '/contacts/987654');
    await run('category-name', 'POST', '/contacts/categories', {});
    await run('category-rename', 'PUT', '/contacts/categories/nope', { name: 'X' });

    assertRefusedInEnglish(seen);
  } finally {
    cServer.close();
  }
});

test('keine Absage der Gesundheit traegt deutschen Wortlaut', async () => {
  const { default: healthRouter } = await import('../server/routes/health.js');
  const who = { userId: ADMIN, role: 'admin' };
  const hApp = express();
  hApp.use(express.json());
  hApp.use((req, _res, next) => {
    req.authUserId = who.userId;
    req.authRole = who.role;
    req.session = { userId: who.userId, role: who.role };
    next();
  });
  hApp.use('/health', healthRouter);
  const hServer = hApp.listen(0, '127.0.0.1');
  const hUrl = await new Promise((r) => hServer.on('listening', () => r(`http://127.0.0.1:${hServer.address().port}`)));
  try {
    const seen = [];
    const call = async (method, route, body, as = { userId: ADMIN, role: 'admin' }) => {
      Object.assign(who, as);
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${hUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      return { status: res.status, body: json };
    };
    const run = async (label, method, route, body, as) => {
      const r = await call(method, route, body, as);
      seen.push({ label, status: r.status, error: r.body?.error ?? null });
    };
    const member = { userId: MEMBER, role: 'member' };
    const report = await call('POST', '/health/labs', {
      report_date: '2026-10-01', results: [{ analyte: 'HbA1c', value_num: 5.4 }],
    });
    assert.equal(report.status, 201, 'Vorbedingung: der Laborbefund wird angelegt');
    const resultId = db.prepare('SELECT id FROM health_lab_results WHERE report_id = ?').get(report.body.data.id).id;

    for (const route of ['/health/activities/x', '/health/vitals/x', '/health/medications/x', '/health/labs/x',
      '/health/results/x', '/health/schedules/x', '/health/logs/x', '/health/cycle/periods/x', '/health/cycle/logs/x']) {
      await run(`delete-id ${route}`, 'DELETE', route);
    }
    await run('labs-get-id', 'GET', '/health/labs/x');
    await run('labs-results-id', 'POST', '/health/labs/x/results', { analyte: 'A', value_num: 1 });
    await run('med-logs-id', 'GET', '/health/medications/x/logs');
    await run('result-clear', 'PATCH', `/health/results/${resultId}`, { value_num: null });
    await run('owner-invalid', 'POST', '/health/labs', { report_date: '2026-10-01', user_id: 'x' });
    await run('owner-foreign', 'POST', '/health/labs', { report_date: '2026-10-01', user_id: ADMIN }, member);
    await run('target-foreign', 'GET', `/health/nutrition/targets?user_id=${ADMIN}`, undefined, member);
    await run('caregivers-subject', 'PUT', '/health/caregivers/x', { caregiver_ids: [] });
    await run('caregivers-gone', 'PUT', '/health/caregivers/987654', { caregiver_ids: [] });
    await run('caregivers-shape', 'PUT', `/health/caregivers/${MEMBER}`, { caregiver_ids: 'x' });
    await run('caregivers-unknown', 'PUT', `/health/caregivers/${MEMBER}`, { caregiver_ids: [987654] });

    assertRefusedInEnglish(seen);
  } finally {
    hServer.close();
  }
});

test('keine Absage der Kalender-Abos, Apple-Anbindung und Kalenderziele traegt deutschen Wortlaut', async () => {
  const { default: calendarRouter } = await import('../server/routes/calendar.js');
  const who = { userId: ADMIN, role: 'admin' };
  const calApp = express();
  calApp.use(express.json());
  calApp.use((req, _res, next) => {
    req.authUserId = who.userId;
    req.authRole = who.role;
    req.session = { userId: who.userId, role: who.role };
    next();
  });
  calApp.use('/calendar', calendarRouter);
  const calServer = calApp.listen(0, '127.0.0.1');
  const calUrl = await new Promise((r) => calServer.on('listening', () => r(`http://127.0.0.1:${calServer.address().port}`)));
  try {
    const seen = [];
    const run = async (label, method, route, body, as = { userId: ADMIN, role: 'admin' }) => {
      Object.assign(who, as);
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${calUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      seen.push({ label, status: res.status, error: json?.error ?? null });
    };
    const member = { userId: MEMBER, role: 'member' };
    const sub = db.prepare("INSERT INTO ics_subscriptions (name, url, created_by) VALUES ('Abo', 'https://ics.example/a.ics', ?)").run(ADMIN).lastInsertRowid;
    const event = { title: 'T', start_datetime: '2026-11-01T10:00', end_datetime: '2026-11-01T11:00' };

    await run('read-range', 'GET', '/calendar?from=x&to=y');
    await run('apple-url', 'POST', '/calendar/apple/connect', { url: 'nope', username: 'u', password: 'p' });
    await run('apple-user', 'POST', '/calendar/apple/connect', { url: 'https://caldav.example/', password: 'p' });
    await run('apple-password', 'POST', '/calendar/apple/connect', { url: 'https://caldav.example/', username: 'u' });
    await run('sub-name', 'POST', '/calendar/subscriptions', { url: 'https://ics.example/b.ics', color: '#112233' });
    await run('sub-url', 'POST', '/calendar/subscriptions', { name: 'B', color: '#112233' });
    await run('sub-scheme', 'POST', '/calendar/subscriptions', { name: 'B', url: 'ftp://ics.example/b.ics', color: '#112233' });
    await run('sub-color', 'POST', '/calendar/subscriptions', { name: 'B', url: 'https://ics.example/b.ics', color: 'red' });
    await run('sub-patch-id', 'PATCH', '/calendar/subscriptions/x', { name: 'X' });
    await run('sub-patch-name', 'PATCH', `/calendar/subscriptions/${sub}`, { name: '' });
    await run('sub-patch-color', 'PATCH', `/calendar/subscriptions/${sub}`, { color: 'red' });
    await run('sub-patch-gone', 'PATCH', '/calendar/subscriptions/987654', { name: 'X' });
    await run('sub-patch-foreign', 'PATCH', `/calendar/subscriptions/${sub}`, { name: 'X' }, member);
    await run('sub-delete-id', 'DELETE', '/calendar/subscriptions/x');
    await run('sub-delete-gone', 'DELETE', '/calendar/subscriptions/987654');
    await run('sub-delete-foreign', 'DELETE', `/calendar/subscriptions/${sub}`, undefined, member);
    await run('sub-sync-id', 'POST', '/calendar/subscriptions/x/sync');
    await run('sub-sync-gone', 'POST', '/calendar/subscriptions/987654/sync');
    await run('sub-sync-foreign', 'POST', `/calendar/subscriptions/${sub}/sync`, undefined, member);
    await run('target-caldav-id', 'POST', '/calendar', { ...event, target_caldav_account_id: 'x' });
    await run('target-caldav-url', 'POST', '/calendar', { ...event, target_caldav_account_id: 1 });
    await run('target-caldav-long', 'POST', '/calendar', { ...event, target_caldav_account_id: 1, target_caldav_calendar_url: 'x'.repeat(3000) });
    await run('target-outlook-id', 'POST', '/calendar', { ...event, target_outlook_account_id: 'x' });
    await run('target-outlook-cal', 'POST', '/calendar', { ...event, target_outlook_account_id: 1 });
    await run('target-outlook-long', 'POST', '/calendar', { ...event, target_outlook_account_id: 1, target_outlook_calendar_id: 'x'.repeat(3000) });
    await run('target-google-long', 'POST', '/calendar', { ...event, target_google_calendar_id: 'x'.repeat(3000) });
    await run('target-caldav-offered', 'POST', '/calendar', { ...event, target_caldav_account_id: 987654, target_caldav_calendar_url: 'https://dav.example/cal/' });

    assertRefusedInEnglish(seen);
  } finally {
    calServer.close();
  }
});

test('keine Absage von Einkauf, Aufgaben, Push und Wetter traegt deutschen Wortlaut', async () => {
  const { default: shoppingRouter } = await import('../server/routes/shopping.js');
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const { default: pushRouter } = await import('../server/routes/push.js');
  const { buildRouter: buildWeatherRouter } = await import('../server/routes/weather.js');
  const gApp = express();
  gApp.use(express.json());
  gApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  gApp.use('/shopping', shoppingRouter);
  gApp.use('/tasks', tasksRouter);
  gApp.use('/push', pushRouter);
  gApp.use('/weather', buildWeatherRouter({ fetchFn: async () => ({ ok: false, status: 404 }) }));
  const gServer = gApp.listen(0, '127.0.0.1');
  const gUrl = await new Promise((r) => gServer.on('listening', () => r(`http://127.0.0.1:${gServer.address().port}`)));
  try {
    const seen = [];
    const call = async (method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${gUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      return { status: res.status, body: json };
    };
    const run = async (label, method, route, body) => {
      const r = await call(method, route, body);
      seen.push({ label, status: r.status, error: r.body?.error ?? null });
    };
    const list = await call('POST', '/shopping', { name: 'L' });
    assert.equal(list.status, 201, 'Vorbedingung: die Liste wird angelegt');
    const listId = list.body.data.id;
    const item = await call('POST', `/shopping/${listId}/items`, { name: 'Milch' });
    assert.equal(item.status, 201, 'Vorbedingung: der Artikel wird angelegt');
    const itemId = item.body.data.id;
    const category = item.body.data.category;
    const top = await call('POST', '/tasks', { title: 'A' });
    const sub = await call('POST', '/tasks', { title: 'B', parent_task_id: top.body.data.id });
    assert.equal(sub.status, 201, 'Vorbedingung: die Unteraufgabe wird angelegt');
    const long = 'x'.repeat(500);

    await run('categories-order', 'PATCH', '/shopping/categories/reorder', { order: [] });
    await run('item-price', 'PATCH', `/shopping/items/${itemId}`, { price_cents: -1 });
    await run('item-store', 'PATCH', `/shopping/items/${itemId}`, { store_id: 'x' });
    await run('item-name', 'PATCH', `/shopping/items/${itemId}`, { name: ' ' });
    await run('item-list', 'PATCH', `/shopping/items/${itemId}`, { list_id: 'x' });
    await run('item-notes', 'PATCH', `/shopping/items/${itemId}`, { notes: 'x'.repeat(20000) });
    await run('reorder-empty', 'PATCH', `/shopping/${listId}/items/reorder`, { category, order: [] });
    await run('reorder-ids', 'PATCH', `/shopping/${listId}/items/reorder`, { category, order: ['x'] });
    await run('reorder-twice', 'PATCH', `/shopping/${listId}/items/reorder`, { category, order: [itemId, itemId] });
    await run('reorder-category', 'PATCH', `/shopping/${listId}/items/reorder`, { order: [itemId] });
    await run('reorder-category-unknown', 'PATCH', `/shopping/${listId}/items/reorder`, { category: 'nope', order: [itemId] });
    await run('reorder-foreign', 'PATCH', `/shopping/${listId}/items/reorder`, { category, order: [987654] });
    await run('add-quantity', 'POST', `/shopping/${listId}/items`, { name: 'A', quantity: long });
    await run('add-notes', 'POST', `/shopping/${listId}/items`, { name: 'A', notes: 'x'.repeat(20000) });
    await run('add-category', 'POST', `/shopping/${listId}/items`, { name: 'A', category: 'nope' });
    await run('checked-ids', 'DELETE', `/shopping/${listId}/items/checked`, { ids: [] });
    await run('checked-ids-shape', 'DELETE', `/shopping/${listId}/items/checked`, { ids: ['x'] });
    await run('task-sync-shape', 'POST', '/tasks', { title: 'C', sync_target: 'nope' });
    await run('task-sync-google', 'POST', '/tasks', { title: 'C', sync_target: 'google:primary' });
    await run('task-sync-list', 'POST', '/tasks', { title: 'C', sync_target: 'caldav:1|https://dav.example/list/' });
    await run('task-nesting', 'POST', '/tasks', { title: 'C', parent_task_id: sub.body.data.id });
    await run('push-subscribe', 'POST', '/push/subscribe', {});
    await run('push-unsubscribe', 'POST', '/push/unsubscribe', {});
    await run('push-wall-mode', 'PUT', '/push/wall-mode', {});
    await run('weather-icon-code', 'GET', '/weather/icon/!!');
    await run('weather-icon-upstream', 'GET', '/weather/icon/01d');

    assertRefusedInEnglish(seen);
  } finally {
    gServer.close();
  }
});

test('keine Absage von Essensplan, Vorrat und Rezepten traegt deutschen Wortlaut', async () => {
  const { default: mealsRouter } = await import('../server/routes/meals.js');
  const { default: pantryRouter } = await import('../server/routes/pantry.js');
  const { default: recipesRouter } = await import('../server/routes/recipes.js');
  const kApp = express();
  kApp.use(express.json({ limit: '10mb' }));
  kApp.use((req, _res, next) => {
    req.authUserId = ADMIN;
    req.authRole = 'admin';
    req.session = { userId: ADMIN, role: 'admin' };
    next();
  });
  kApp.use('/meals', mealsRouter);
  kApp.use('/pantry', pantryRouter);
  kApp.use('/recipes', recipesRouter);
  const kServer = kApp.listen(0, '127.0.0.1');
  const kUrl = await new Promise((r) => kServer.on('listening', () => r(`http://127.0.0.1:${kServer.address().port}`)));
  try {
    const seen = [];
    const call = async (method, route, body) => {
      const headers = {};
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(`${kUrl}${route}`, { method, headers, body: payload });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* kein JSON */ }
      return { status: res.status, body: json };
    };
    const run = async (label, method, route, body) => {
      const r = await call(method, route, body);
      seen.push({ label, status: r.status, error: r.body?.error ?? null });
    };
    const series = await call('POST', '/meals', { date: '2026-11-02', meal_type: 'dinner', title: 'Suppe', repeat_weekly: true });
    assert.equal(series.status, 201, 'Vorbedingung: die Serie wird angelegt');
    const mealId = series.body.data.id;
    const longText = 'x'.repeat(20000);

    await run('meal-date', 'POST', '/meals', { meal_type: 'dinner', title: 'A' });
    await run('meal-type', 'POST', '/meals', { date: '2026-11-02', meal_type: 'nope', title: 'A' });
    await run('meal-title', 'POST', '/meals', { date: '2026-11-02', meal_type: 'dinner' });
    await run('meal-notes', 'POST', '/meals', { date: '2026-11-02', meal_type: 'dinner', title: 'A', notes: longText });
    await run('meal-until', 'POST', '/meals', { date: '2026-11-02', meal_type: 'dinner', title: 'A', repeat_weekly: true, repeat_until: 'x' });
    await run('plan-skip', 'POST', '/meals/apply-plan', { assignments: [], skip_occupied: 'x' });
    await run('plan-both', 'POST', '/meals/apply-plan', { assignments: [], skip_occupied: true, replace_existing: true });
    await run('plan-empty', 'POST', '/meals/apply-plan', { assignments: [] });
    await run('plan-entry', 'POST', '/meals/apply-plan', { assignments: [{ date: '2026-11-02', meal_type: 'nope' }] });
    await run('put-gone', 'PUT', '/meals/987654', { title: 'X' });
    await run('put-type', 'PUT', `/meals/${mealId}`, { meal_type: 'nope' });
    await run('put-until', 'PUT', `/meals/${mealId}?scope=series`, { repeat_until: '2026-10-01' });
    await run('put-until-shape', 'PUT', `/meals/${mealId}?scope=series`, { repeat_until: 'x' });
    await run('delete-gone', 'DELETE', '/meals/987654');
    await run('ingredient-meal', 'POST', '/meals/987654/ingredients', { name: 'Salz' });
    await run('ingredient-name', 'POST', `/meals/${mealId}/ingredients`, {});
    await run('ingredient-gone', 'PATCH', '/meals/ingredients/987654', { name: 'X' });
    await run('ingredient-delete-gone', 'DELETE', '/meals/ingredients/987654');
    await run('to-list-meal', 'POST', '/meals/987654/to-shopping-list', { listId: 1 });
    await run('to-list-id', 'POST', `/meals/${mealId}/to-shopping-list`, {});
    await run('to-list-gone', 'POST', `/meals/${mealId}/to-shopping-list`, { listId: 987654 });
    await run('week-list-id', 'POST', '/meals/week-to-shopping-list', { week: '2026-11-02' });
    await run('week-date', 'POST', '/meals/week-to-shopping-list', { listId: 1, week: 'x' });
    await run('week-list-gone', 'POST', '/meals/week-to-shopping-list', { listId: 987654, week: '2026-11-02' });
    await run('pantry-quantity', 'POST', '/pantry', { name: 'Reis', quantity: -1 });
    await run('pantry-location', 'POST', '/pantry', { name: 'Reis', location_id: 987654 });
    await run('pantry-category', 'POST', '/pantry', { name: 'Reis', category: 'nope' });
    await run('pantry-expires', 'POST', '/pantry', { name: 'Reis', expires_on: 'x' });
    await run('pantry-min', 'POST', '/pantry', { name: 'Reis', min_quantity: -1 });
    await run('pantry-notes', 'POST', '/pantry', { name: 'Reis', notes: longText });
    await run('pantry-item-id', 'PUT', '/pantry/x', { name: 'Reis' });
    await run('location-name', 'POST', '/pantry/locations', {});
    await run('location-id', 'PUT', '/pantry/locations/x', { name: 'X' });
    await run('recipe-title', 'POST', '/recipes', {});
    await run('recipe-notes', 'POST', '/recipes', { title: 'A', notes: longText });

    assertRefusedInEnglish(seen);
  } finally {
    kServer.close();
  }
});
