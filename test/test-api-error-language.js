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
 *        deutschen Wort.
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
  ['calendar/apple.js', 6],
  ['calendar/feed.js', 5],
  ['calendar/google.js', 22],
  ['calendar/helpers.js', 6],
  ['calendar/local-calendars.js', 7],
  ['calendar/outlook.js', 3],
  ['calendar/read.js', 4],
  ['calendar/subscriptions.js', 22],
  ['contacts.js', 13],
  ['health/activities.js', 2],
  ['health/caregivers.js', 3],
  ['health/cycle.js', 3],
  ['health/helpers.js', 2],
  ['health/labs.js', 6],
  ['health/medications.js', 12],
  ['health/nutrition.js', 1],
  ['health/vitals.js', 2],
  ['inventory/item-dates.js', 5],
  ['inventory/items.js', 9],
  ['inventory/service-log.js', 6],
  ['meals.js', 34],
  ['notes.js', 14],
  ['pantry.js', 5],
  ['push.js', 3],
  ['quick-links.js', 10],
  ['recipes.js', 2],
  ['reminders.js', 10],
  ['shopping.js', 17],
  ['tasks.js', 3],
  ['weather.js', 2],
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
  ]) assert.ok(germanIn(old), `nicht erkannt: ${old}`);
  for (const fine of [
    'Internal server error.',
    'timezone_hint_dismissed must be true or false.',
    'Invalid time zone. Expected an IANA zone such as "Europe/Berlin".',
    'Invalid region.',
    'Admin access required.',
    'Invalid country code (2 capital letters, e.g. DE).',
    'calendar_default_target may be at most 300 characters long.',
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
  // Eine Datei aus einem Unterordner zaehlt mit (routes/calendar/).
  assert.ok(germanByFile().has('calendar/google.js') || !GERMAN_LEFT.has('calendar/google.js'),
    'Unterordner werden nicht gelesen');
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
