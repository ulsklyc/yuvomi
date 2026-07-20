/**
 * Modul: Preferences-Routen-Test (Härtung Coverage-Track)
 * Zweck: HTTP-Schicht von server/routes/preferences.js gegen den echten Router,
 *        soweit von den bestehenden preferences-Tests (weekstart/weather/
 *        navigation/budget-mode) NICHT abgedeckt: der field-by-field PUT /-
 *        Handler (Validierung 400, Admin-403-Gates, Persistenz + Echo je Feld),
 *        das per-user weather_user-Objekt, der holiday-Config-Block sowie die
 *        holidays-Routen (netz-frei via __setFetchImpl-Stub bzw. route-eigene
 *        400/403-Gates) und die defensiven Parse-Fallbacks der Lese-Helfer.
 * Ausführen: node --test test/test-preferences-routes.js
 *
 * Netz-frei: reine sync_config-CRUD; die OpenHolidays-API ist gestubbt.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const holidays = await import('../server/services/holidays.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

// Modulweiter Akteur; die Middleware liest ihn zur Request-Zeit.
const actor = { userId: 1, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.userId;
  req.authRole = actor.role;
  next();
});
app.use('/', preferencesRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); holidays.__setFetchImpl(null); });
// Deterministisch nach JEDEM Test zuruecksetzen, damit ein Fehlschlag (z. B. in
// einem gestubbten Holidays-Test) weder den fetch-Stub noch den Akteur leakt.
test.afterEach(() => { holidays.__setFetchImpl(null); actor.userId = 1; actor.role = 'admin'; });

async function put(body, { role = 'admin', userId = 1 } = {}) {
  actor.role = role; actor.userId = userId;
  const res = await fetch(`${base}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function get({ role = 'admin', userId = 1 } = {}) {
  actor.role = role; actor.userId = userId;
  const res = await fetch(`${base}/`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function raw(method, path, { role = 'admin', userId = 1 } = {}) {
  actor.role = role; actor.userId = userId;
  const res = await fetch(`${base}${path}`, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const cfgSet = (k, v) => db.prepare(
  `INSERT INTO sync_config (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(k, v);
const cfgDelete = (k) => db.prepare('DELETE FROM sync_config WHERE key = ?').run(k);

// --------------------------------------------------------
// GET / - Default-Shape
// --------------------------------------------------------
test('GET / liefert die dokumentierten Defaults', async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.data.currency, 'EUR');
  assert.equal(body.data.date_format, 'dmy');
  assert.equal(body.data.time_format, '24h');
  assert.equal(body.data.week_start, 'monday');
  assert.equal(body.data.app_name, 'Yuvomi');
  assert.equal(body.data.budget_mode, 'shared');
  assert.equal(body.data.calendar_default_duration, 60);
  assert.deepEqual(body.data.visible_meal_types, ['breakfast', 'lunch', 'dinner', 'snack']);
  // Feature-Schalter default an (fehlender Wert => aktiv).
  assert.equal(body.data.health_cycle_enabled, true);
  assert.equal(body.data.rewards_require_approval, true);
});

// --------------------------------------------------------
// visible_meal_types
// --------------------------------------------------------
test('PUT visible_meal_types: Nicht-Array -> 400', async () => {
  assert.equal((await put({ visible_meal_types: 'breakfast' })).status, 400);
});
test('PUT visible_meal_types: leer nach Filter -> 400', async () => {
  assert.equal((await put({ visible_meal_types: ['nonsense'] })).status, 400);
});
test('PUT visible_meal_types: gültige Teilmenge persistiert + filtert Unbekanntes', async () => {
  const { status, body } = await put({ visible_meal_types: ['breakfast', 'dinner', 'nope'] });
  assert.equal(status, 200);
  assert.deepEqual(body.data.visible_meal_types, ['breakfast', 'dinner']);
  assert.deepEqual((await get()).body.data.visible_meal_types, ['breakfast', 'dinner']);
});

// --------------------------------------------------------
// currency / date_format / time_format / region
// --------------------------------------------------------
test('PUT currency: ungültig -> 400, gültig -> persist', async () => {
  assert.equal((await put({ currency: 'XXX' })).status, 400);
  assert.equal((await put({ currency: 'USD' })).body.data.currency, 'USD');
  assert.equal((await get()).body.data.currency, 'USD');
});
test('PUT date_format: ungültig -> 400, gültig -> persist', async () => {
  assert.equal((await put({ date_format: 'zzz' })).status, 400);
  assert.equal((await put({ date_format: 'mdy' })).body.data.date_format, 'mdy');
});
test('PUT time_format: ungültig -> 400, gültig -> persist', async () => {
  assert.equal((await put({ time_format: '48h' })).status, 400);
  assert.equal((await put({ time_format: '12h' })).body.data.time_format, '12h');
});
test('PUT region: ungültig -> 400, gültig -> persist, null -> leer', async () => {
  assert.equal((await put({ region: 'x' })).status, 400);
  assert.equal((await put({ region: 'de-DE' })).body.data.region, 'de-DE');
  assert.equal((await put({ region: null })).body.data.region, null);
});

// --------------------------------------------------------
// app_name (str-Validator, empty->delete)
// --------------------------------------------------------
test('PUT app_name: zu lang -> 400', async () => {
  assert.equal((await put({ app_name: 'x'.repeat(101) })).status, 400);
});
test('PUT app_name: gültig -> persist, leer -> Rückfall auf Default', async () => {
  assert.equal((await put({ app_name: 'Familie Muster' })).body.data.app_name, 'Familie Muster');
  // Leerer Wert löscht -> GET fällt auf den Default 'Yuvomi' zurück.
  assert.equal((await put({ app_name: '   ' })).body.data.app_name, 'Yuvomi');
  assert.equal((await get()).body.data.app_name, 'Yuvomi');
});

// --------------------------------------------------------
// dashboard_widgets (normalizeWidgetConfig)
// --------------------------------------------------------
test('PUT dashboard_widgets: Nicht-Array -> 400', async () => {
  assert.equal((await put({ dashboard_widgets: {} })).status, 400);
});
test('PUT dashboard_widgets: Teilmenge -> fehlende IDs werden ergänzt, order neu vergeben', async () => {
  const { status, body } = await put({ dashboard_widgets: [{ id: 'notes', visible: false, size: '2x1' }] });
  assert.equal(status, 200);
  const widgets = body.data.dashboard_widgets;
  // Alle 13 IDs vorhanden, notes zuerst und unsichtbar, order lückenlos 0..n.
  assert.equal(widgets.length, 13);
  assert.equal(widgets[0].id, 'notes');
  assert.equal(widgets[0].visible, false);
  assert.deepEqual(widgets.map((w) => w.order), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // Ergänzte Opt-in-Widgets starten unsichtbar, Kern-Widgets sichtbar.
  const byId = Object.fromEntries(widgets.map((w) => [w.id, w]));
  for (const id of ['rewards', 'health', 'cycle', 'housekeeping']) assert.equal(byId[id].visible, false, id);
  for (const id of ['tasks', 'calendar', 'weather']) assert.equal(byId[id].visible, true, id);
});
test('PUT dashboard_widgets: Opt-in-Widget sichtbar geschaltet -> ueberlebt den Roundtrip', async () => {
  const { status, body } = await put({ dashboard_widgets: [{ id: 'rewards', visible: true, size: '1x2' }] });
  assert.equal(status, 200);
  const rewards = body.data.dashboard_widgets.find((w) => w.id === 'rewards');
  assert.ok(rewards, 'rewards bleibt in der gespeicherten Config');
  assert.equal(rewards.visible, true);
});

// --------------------------------------------------------
// housekeeping_payment_tasks / calendar_default_duration
// --------------------------------------------------------
test('PUT housekeeping_payment_tasks: Nicht-Boolean -> 400, true -> persist', async () => {
  assert.equal((await put({ housekeeping_payment_tasks: 'yes' })).status, 400);
  assert.equal((await put({ housekeeping_payment_tasks: true })).body.data.housekeeping_payment_tasks, true);
});
test('PUT calendar_default_duration: unzulässig -> 400, gültig -> persist', async () => {
  assert.equal((await put({ calendar_default_duration: 4 })).status, 400);       // < MIN 5
  assert.equal((await put({ calendar_default_duration: 5000 })).status, 400);    // > MAX 1440
  assert.equal((await put({ calendar_default_duration: 3.5 })).status, 400);     // nicht ganzzahlig
  assert.equal((await put({ calendar_default_duration: 30 })).body.data.calendar_default_duration, 30);
});

// --------------------------------------------------------
// calendar_default_reminders / assign_me (per-user)
// --------------------------------------------------------
test('PUT calendar_default_reminders: Validierung + dedup/sort persist', async () => {
  assert.equal((await put({ calendar_default_reminders: 'x' })).status, 400);
  assert.equal((await put({ calendar_default_reminders: [7] })).status, 400);            // ungültiger Offset
  assert.equal((await put({ calendar_default_reminders: [0, 15, 60, 1440, 2880, 10080] })).status, 400); // > 5
  const ok = await put({ calendar_default_reminders: [60, 0, 60] });
  assert.deepEqual(ok.body.data.calendar_default_reminders, [0, 60]);
});
test('PUT calendar_default_assign_me: Boolean -> per-user persist', async () => {
  assert.equal((await put({ calendar_default_assign_me: true })).body.data.calendar_default_assign_me, true);
  assert.equal((await put({ calendar_default_assign_me: false })).body.data.calendar_default_assign_me, false);
});

test('PUT module_order: Nicht-Array -> 400, gültige Liste -> per-user round-trip', async () => {
  assert.equal((await put({ module_order: 'tasks' })).status, 400);
  const ok = await put({ module_order: ['calendar', 'tasks', 'calendar', 'nonsense'] });
  // dedupliziert + unbekanntes verworfen, per-user gelesen.
  assert.deepEqual(ok.body.data.module_order, ['calendar', 'tasks']);
  assert.deepEqual((await get()).body.data.module_order, ['calendar', 'tasks']);
});

// --------------------------------------------------------
// Admin-gated Feature-Schalter (403 fuer Mitglieder, kein Bypass)
// --------------------------------------------------------
test('PUT disabled_modules: Mitglied -> 403, Admin validiert + persist', async () => {
  assert.equal((await put({ disabled_modules: ['tasks'] }, { role: 'member' })).status, 403);
  assert.equal((await put({ disabled_modules: 'tasks' }, { role: 'admin' })).status, 400);
  const ok = await put({ disabled_modules: ['tasks', 'budget', 'tasks', 'nonsense'] }, { role: 'admin' });
  assert.deepEqual(ok.body.data.disabled_modules.sort(), ['budget', 'tasks']);
});
test('PUT health_cycle_enabled: Mitglied -> 403, Admin non-boolean 400, false persist', async () => {
  assert.equal((await put({ health_cycle_enabled: false }, { role: 'member' })).status, 403);
  assert.equal((await put({ health_cycle_enabled: 'no' }, { role: 'admin' })).status, 400);
  assert.equal((await put({ health_cycle_enabled: false }, { role: 'admin' })).body.data.health_cycle_enabled, false);
});
test('PUT rewards_require_approval: Mitglied -> 403, Admin non-boolean 400, false persist', async () => {
  assert.equal((await put({ rewards_require_approval: false }, { role: 'member' })).status, 403);
  assert.equal((await put({ rewards_require_approval: 'no' }, { role: 'admin' })).status, 400);
  assert.equal((await put({ rewards_require_approval: false }, { role: 'admin' })).body.data.rewards_require_approval, false);
});

// --------------------------------------------------------
// Weather (haushaltweit, admin only) - gezielt die ungedeckten Validierungen
// --------------------------------------------------------
test('PUT weather_*: Mitglied -> 403', async () => {
  assert.equal((await put({ weather_units: 'metric' }, { role: 'member' })).status, 403);
});
test('PUT weather: einzelne Validierungspfade -> 400', async () => {
  assert.equal((await put({ weather_provider: 'foo' })).status, 400);
  assert.equal((await put({ weather_lat: 200 })).status, 400);
  assert.equal((await put({ weather_lon: 999 })).status, 400);
  assert.equal((await put({ weather_units: 'kelvin' })).status, 400);
  assert.equal((await put({ weather_auto_locate: 'x' })).status, 400);
});
test('PUT weather: provider=null und city="" löschen den Wert', async () => {
  await put({ weather_provider: 'open-meteo', weather_city: 'Berlin' });
  assert.equal((await get()).body.data.weather_provider, 'open-meteo');
  const cleared = await put({ weather_provider: null, weather_city: '   ' });
  assert.equal(cleared.body.data.weather_provider, null);
  assert.equal(cleared.body.data.weather_city, '');
});

// --------------------------------------------------------
// weather_user (per-user Override-Objekt)
// --------------------------------------------------------
test('PUT weather_user: Nicht-Objekt -> 400', async () => {
  assert.equal((await put({ weather_user: [1, 2] })).status, 400);
});
test('PUT weather_user: fehlende authUserId -> 401', async () => {
  const res = await put({ weather_user: { city: 'X' } }, { userId: null });
  assert.equal(res.status, 401);
});
test('PUT weather_user: Feld-Validierungen -> 400', async () => {
  assert.equal((await put({ weather_user: { lat: 91 } })).status, 400);
  assert.equal((await put({ weather_user: { lon: -181 } })).status, 400);
  assert.equal((await put({ weather_user: { units: 'kelvin' } })).status, 400);
  assert.equal((await put({ weather_user: { auto_locate: 'x' } })).status, 400);
});
test('PUT weather_user: gültige Werte persistieren, null löscht je Feld', async () => {
  const set = await put({ weather_user: { lat: 52.5, lon: 13.4, city: 'Berlin', units: 'imperial', auto_locate: true } });
  assert.equal(set.body.data.weather_user.city, 'Berlin');
  assert.equal(set.body.data.weather_user.units, 'imperial');
  assert.equal(set.body.data.weather_user.auto_locate, true);
  const cleared = await put({ weather_user: { lat: null, lon: null, city: null, units: null, auto_locate: null } });
  assert.equal(cleared.body.data.weather_user.lat, null);
  assert.equal(cleared.body.data.weather_user.city, null);
  assert.equal(cleared.body.data.weather_user.auto_locate, null);
});

// --------------------------------------------------------
// Holiday-Konfiguration (admin only)
// --------------------------------------------------------
test('PUT holiday_*: Mitglied -> 403', async () => {
  assert.equal((await put({ holiday_country: 'DE' }, { role: 'member' })).status, 403);
});
test('PUT holiday: Validierungspfade -> 400', async () => {
  assert.equal((await put({ holiday_country: 'ger' })).status, 400);
  assert.equal((await put({ holiday_subdivision: 'bayern' })).status, 400);
  assert.equal((await put({ holiday_group: 'x' })).status, 400);
  assert.equal((await put({ holiday_show_public: 'x' })).status, 400);
  assert.equal((await put({ holiday_public_color: 'red' })).status, 400);
  assert.equal((await put({ holiday_school_color: '#12' })).status, 400);
});
test('PUT holiday: gültige Vollkonfiguration persistiert', async () => {
  const { status, body } = await put({
    holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY',
    holiday_show_public: true, holiday_show_school: false,
    holiday_public_color: '#FF0000', holiday_school_color: '#00FF00',
  });
  assert.equal(status, 200);
  assert.equal(body.data.holiday_country, 'DE');
  assert.equal(body.data.holiday_subdivision, 'DE-BY');
  assert.equal(body.data.holiday_show_public, true);
  assert.equal(body.data.holiday_public_color, '#FF0000');
});
test('PUT holiday_country=null räumt subdivision + group mit auf (Kaskade)', async () => {
  await put({ holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY' });
  const { body } = await put({ holiday_country: null });
  assert.equal(body.data.holiday_country, null);
  assert.equal(body.data.holiday_subdivision, null);
  assert.equal(body.data.holiday_group, null);
});
test('PUT holiday_subdivision=null / holiday_group=null löschen gezielt', async () => {
  await put({ holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY' });
  // subdivision=null räumt subdivision + group, Land bleibt.
  const a = await put({ holiday_subdivision: null });
  assert.equal(a.body.data.holiday_country, 'DE');
  assert.equal(a.body.data.holiday_subdivision, null);
  assert.equal(a.body.data.holiday_group, null);
  // group leerer String löscht nur die Gruppe.
  await put({ holiday_subdivision: 'DE-BY', holiday_group: 'DE-BY' });
  const b = await put({ holiday_group: '' });
  assert.equal(b.body.data.holiday_group, null);
  assert.equal(b.body.data.holiday_subdivision, 'DE-BY');
});
test('PUT holiday_show_school: Nicht-Boolean -> 400', async () => {
  assert.equal((await put({ holiday_show_school: 'x' })).status, 400);
});

// --------------------------------------------------------
// Holidays-Routen (OpenHolidays gestubbt / route-eigene Gates netz-frei)
// --------------------------------------------------------
test('GET /holidays/countries: gestubbte API -> 200 mit sortierter Liste', async () => {
  holidays.__setFetchImpl(async () => ({
    ok: true,
    json: async () => [
      { isoCode: 'DE', name: [{ language: 'EN', text: 'Germany' }] },
      { isoCode: 'AT', name: [{ language: 'EN', text: 'Austria' }] },
    ],
  }));
  const res = await raw('GET', '/holidays/countries');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((c) => c.isoCode), ['AT', 'DE']); // nach name sortiert
  holidays.__setFetchImpl(null);
});
test('GET /holidays/countries: API-Fehler -> 502', async () => {
  holidays.__setFetchImpl(async () => { throw new Error('network down'); });
  assert.equal((await raw('GET', '/holidays/countries')).status, 502);
  holidays.__setFetchImpl(null);
});
test('GET /holidays/subdivisions/:cc: ungültiger Code -> 400', async () => {
  assert.equal((await raw('GET', '/holidays/subdivisions/xx')).status, 400);
});
test('GET /holidays/subdivisions/:cc: gestubbt -> 200', async () => {
  holidays.__setFetchImpl(async () => ({
    ok: true, json: async () => [{ code: 'DE-BY', name: [{ language: 'EN', text: 'Bavaria' }] }],
  }));
  const res = await raw('GET', '/holidays/subdivisions/DE');
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].isoCode, 'DE-BY');
  holidays.__setFetchImpl(null);
});
test('GET /holidays/groups/:cc/:sc: ungültige Codes -> 400', async () => {
  assert.equal((await raw('GET', '/holidays/groups/xx/DE-BY')).status, 400);
  assert.equal((await raw('GET', '/holidays/groups/CH/bern')).status, 400);
});
test('GET /holidays/groups/:cc/:sc: gestubbt -> 200', async () => {
  holidays.__setFetchImpl(async () => ({
    ok: true,
    json: async () => [{
      code: 'CH-BE',
      groups: [
        { code: 'CH-BE-VS', shortName: 'VS' },
        { code: 'CH-BE-EO', shortName: 'EO' },
      ],
    }],
  }));
  const res = await raw('GET', '/holidays/groups/CH/CH-BE');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  holidays.__setFetchImpl(null);
});
test('POST /holidays/sync: Mitglied -> 403', async () => {
  assert.equal((await raw('POST', '/holidays/sync', { role: 'member' })).status, 403);
});
test('POST /holidays/sync: Admin ohne konfiguriertes Land -> 200 (netz-freier Early-Return)', async () => {
  cfgDelete('holiday_country');
  const res = await raw('POST', '/holidays/sync', { role: 'admin' });
  assert.equal(res.status, 200);
  assert.ok('last_sync' in res.body.data);
});

// --------------------------------------------------------
// Defensive Parse-Fallbacks der Lese-Helfer (korrupte sync_config-Werte)
// --------------------------------------------------------
test('GET / verkraftet korrupte dashboard_widgets (Fallback auf Default)', async () => {
  cfgSet('dashboard_widgets', '{ kaputt');
  const widgets = (await get()).body.data.dashboard_widgets;
  assert.equal(widgets.length, 13); // Default-Set
  cfgDelete('dashboard_widgets');
});
test('GET / verkraftet korrupte per-user calendar_default_reminders', async () => {
  cfgSet('calendar_default_reminders:user:1', 'nicht-json');
  assert.deepEqual((await get()).body.data.calendar_default_reminders, []);
  cfgDelete('calendar_default_reminders:user:1');
});
test('GET / verkraftet korrupte disabled_modules / module_order / mobile_nav_order', async () => {
  cfgSet('disabled_modules', '{oops');
  cfgSet('module_order:user:1', '{oops');
  cfgSet('mobile_nav_order:user:1', '{oops');
  const d = (await get()).body.data;
  assert.deepEqual(d.disabled_modules, []);
  assert.deepEqual(d.module_order, []);
  assert.deepEqual(d.mobile_nav_order, []);
  cfgDelete('disabled_modules'); cfgDelete('module_order:user:1'); cfgDelete('mobile_nav_order:user:1');
});

// --------------------------------------------------------
// Fehlende authUserId: per-user cfg-Helfer sind No-ops (kein Crash)
// --------------------------------------------------------
test('PUT module_order ohne authUserId: cfgUserSet ist No-op, kein Fehler', async () => {
  const res = await put({ module_order: ['tasks', 'calendar'] }, { userId: null });
  assert.equal(res.status, 200);
  // Ohne User-Kontext wird nichts per-user gespeichert -> Leseseite bleibt leer.
  assert.deepEqual(res.body.data.module_order, []);
});
