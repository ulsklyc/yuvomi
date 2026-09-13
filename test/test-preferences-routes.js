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
// Die Zone gehoert festgenagelt wie DB_PATH darueber. Ohne Vorgabe faellt
// `serverTimeZone()` auf die Zone des Rechners zurueck, und dann prueft jede
// Maschine etwas anderes: die Probe zu `timezone_effective` weiter unten stand
// fest auf 'Pacific/Auckland' und war auf einer Maschine in Auckland
// unerfuellbar ("Expected actual to be strictly unequal to: 'Pacific/Auckland'").
// Genauso halten es test-household-timezone.js, test-display-timezone.js,
// test-countdown.js und test-tasks-recurrence.js.
process.env.TZ = 'UTC';

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
  assert.equal(body.data.tasks_subtasks_expanded, false);
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
// meal_type_names (#1058) - Haushaltsnamen ueber stabilen Slot-Schluesseln
// --------------------------------------------------------
test('PUT meal_type_names: Nicht-Objekt -> 400', async () => {
  assert.equal((await put({ meal_type_names: 'Zmittag' })).status, 400);
  assert.equal((await put({ meal_type_names: ['Zmittag'] })).status, 400);
});
test('PUT meal_type_names: Nicht-String als Wert -> 400', async () => {
  assert.equal((await put({ meal_type_names: { lunch: 42 } })).status, 400);
});
test('PUT meal_type_names: zu langer Name -> 400', async () => {
  assert.equal((await put({ meal_type_names: { lunch: 'x'.repeat(41) } })).status, 400);
  assert.equal((await put({ meal_type_names: { lunch: 'x'.repeat(40) } })).status, 200);
});
test('PUT meal_type_names: Name wird gespeichert und wieder gelesen', async () => {
  // Ein Komma im Namen ist der Grund fuer JSON statt der kommaseparierten Form
  // von visible_meal_types nebenan: ein split(',') machte hier zwei Namen.
  const { status, body } = await put({ meal_type_names: { lunch: '  Zmittag  ', snack: 'Znueni, spaet' } });
  assert.equal(status, 200);
  assert.deepEqual(body.data.meal_type_names, { lunch: 'Zmittag', snack: 'Znueni, spaet' });
  assert.deepEqual((await get()).body.data.meal_type_names, { lunch: 'Zmittag', snack: 'Znueni, spaet' });
});
test('PUT meal_type_names: unbekannter Slot faellt weg, ohne den Request zu kippen', async () => {
  const { status, body } = await put({ meal_type_names: { lunch: 'Zmittag', brunch: 'Elf Uhr' } });
  assert.equal(status, 200);
  assert.deepEqual(body.data.meal_type_names, { lunch: 'Zmittag' });
});
test('PUT meal_type_names: leerer Name entfernt ihn - das eingebaute Wort gilt wieder', async () => {
  await put({ meal_type_names: { lunch: 'Zmittag', snack: 'Znueni' } });
  const { body } = await put({ meal_type_names: { lunch: '', snack: 'Znueni' } });
  assert.deepEqual(body.data.meal_type_names, { snack: 'Znueni' });
  // Und der Weg ganz zurueck: null loescht die Zeile, GET faellt auf {} zurueck.
  await put({ meal_type_names: null });
  assert.deepEqual((await get()).body.data.meal_type_names, {});
});
test('GET meal_type_names: eine kaputte Zeile liefert {}, keinen 500er', async () => {
  // Der Lesepfad darf an handgeschriebenem Muell in sync_config nicht sterben -
  // sonst nimmt eine unlesbare Zeile die ganze Praeferenz-Antwort mit.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('meal_type_names', '{kaputt')"
    + " ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body.data.meal_type_names, {});
  await put({ meal_type_names: null });
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
test('PUT timezone: Mitglied -> 403, ungültig -> 400, gültig -> persist, null -> Rückfall', async () => {
  // Admin-Gate wie bei Region und Datensprache: an der Zone haengen der
  // Kalendertag der Server-Jobs, die Zone im abonnierten ICS-Feed und die
  // Uhrzeit, mit der Termine zu Google und Outlook gehen (#829).
  assert.equal((await put({ timezone: 'Asia/Tokyo' }, { role: 'member' })).status, 403);
  assert.equal((await put({ timezone: 'Mars/Olympus_Mons' })).status, 400);
  assert.equal((await put({ timezone: 'Asia/Tokyo' })).body.data.timezone, 'Asia/Tokyo');
  // Alias statt kanonischem Namen: die Route prueft gegen ICU, nicht gegen
  // `Intl.supportedValuesOf` - das fuehrt nur die kanonischen Namen.
  assert.equal((await put({ timezone: 'Europe/Kiev' })).body.data.timezone, 'Europe/Kiev');
  // null loescht die Einstellung; `timezone_effective` bleibt trotzdem gefuellt,
  // sonst haette die Oberflaeche fuer "Automatisch" nichts zu beschriften.
  const cleared = (await put({ timezone: null })).body.data;
  assert.equal(cleared.timezone, null);
  assert.ok(cleared.timezone_effective, 'timezone_effective ist nie leer');
});

/* Der geltende Wert wird POSITIV geprueft, nicht per Verneinung.
 *
 * Hier stand `assert.notEqual(fallback.timezone_effective, 'Pacific/Auckland')`
 * - dieselbe Zone, die zwei Zeilen darueber gesetzt wurde. Zwei Schwaechen in
 * einer Zeile: auf einer Maschine in Auckland ist der Rueckfall genau dieser
 * Wert, die Behauptung dort also unerfuellbar (das `process.env.TZ` am
 * Dateikopf raeumt das aus); und eine Verneinung liesse eine beliebige DRITTE
 * Zone durch.
 *
 * Was `timezone_effective` ohne Einstellung sein soll, steht in
 * `householdTimeZone()`: der Rueckfall auf `serverTimeZone()`, und der ist hier
 * auf 'UTC' genagelt.
 *
 * DER SOLLWERT IST DESHALB EIN LITERAL UND NICHT `serverTimeZone()`. Stuende
 * dort der Aufruf, bildete dieselbe Funktion beide Seiten der Zusicherung, und
 * ein falscher Rueckfallwert verschoebe beide gleichzeitig. Nachgemessen mit
 * `serverTimeZone()` auf einen festen Fremdwert sabotiert:
 *
 *   Sollwert = serverTimeZone()  -> gruen unter UTC, Europe/Berlin, Auckland
 *   Sollwert = 'UTC' (so wie es jetzt dasteht) -> rot unter allen dreien
 *
 * (Eine Sabotage, die nur das Lesen von `TZ` ausbaut, taugt hier NICHT als
 * Gegenprobe: mit gepinntem `TZ` liefern beide Zweige von `serverTimeZone()`
 * denselben Wert, sie ist also wirkungslos. Auch gemessen.)
 */
test('GET timezone: gewählter Wert und geltender Wert sind zwei Felder', async () => {
  await put({ timezone: 'Pacific/Auckland' });
  const body = (await get()).body.data;
  assert.equal(body.timezone, 'Pacific/Auckland');
  assert.equal(body.timezone_effective, 'Pacific/Auckland');

  await put({ timezone: null });
  const fallback = (await get()).body.data;
  assert.equal(fallback.timezone, null);
  assert.equal(fallback.timezone_effective, 'UTC',
    'ohne Einstellung nennt timezone_effective den Serverrueckfall (process.env.TZ am Dateikopf)');
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
test('PUT dashboard_widgets: ungültige Struktur, doppelte IDs oder zu viele Einträge -> 400', async () => {
  assert.equal((await put({ dashboard_widgets: [{ id: '../weather', visible: true, order: 0, size: '1x1' }] })).status, 400);
  assert.equal((await put({ dashboard_widgets: [{ id: 'weather', visible: 'yes', order: 0, size: '1x1' }] })).status, 400);
  assert.equal((await put({ dashboard_widgets: [{ id: 'weather', visible: true, order: 'first', size: '1x1' }] })).status, 400);
  assert.equal((await put({ dashboard_widgets: [{ id: 'weather', visible: true, order: 0, size: '5x5' }] })).status, 400);
  assert.equal((await put({ dashboard_widgets: [
    { id: 'weather', visible: true, order: 0, size: '1x1' },
    { id: 'weather', visible: false, order: 1, size: '1x1' },
  ] })).status, 400);
  const tooMany = Array.from({ length: 65 }, (_, order) => ({
    id: `widget-${order}`,
    visible: true,
    order,
    size: '1x1',
  }));
  assert.equal((await put({ dashboard_widgets: tooMany })).status, 400);
});
// --------------------------------------------------------
// dashboard_today_glance (#740)
// --------------------------------------------------------
test('dashboard_today_glance ist standardmäßig an - der Bestand kennt den Schlüssel nicht', async () => {
  const res = await get();
  assert.equal(res.body.data.dashboard_today_glance, true);
});
test('PUT dashboard_today_glance: alles ausser Boolean und null -> 400', async () => {
  // '0'/'1' waeren die DB-Schreibweise, nicht die der API - wer sie schickt,
  // meint etwas anderes als er bekaeme.
  assert.equal((await put({ dashboard_today_glance: '0' })).status, 400);
  assert.equal((await put({ dashboard_today_glance: 0 })).status, 400);
});
test('null ist kein ungueltiger Boolean, sondern der Rueckweg zur Vorgabe (#827)', async () => {
  // Dieselbe Schreibweise wie bei `timezone` und `language` nebenan: null heisst
  // nicht "aus", sondern "ich habe hier nichts Eigenes". Bis v2.34.0 war es ein
  // 400 - es gab schlicht keinen Weg zurueck.
  assert.equal((await put({ dashboard_today_glance: false })).status, 200);
  assert.equal((await get()).body.data.dashboard_follows_default, false);
  assert.equal((await put({ dashboard_today_glance: null })).status, 200);
  const back = await get();
  assert.equal(back.body.data.dashboard_today_glance, true, 'die Vorgabe greift nicht wieder');
  assert.equal(back.body.data.dashboard_follows_default, true);
});
test('dashboard_today_glance haelt beide Richtungen ueber den GET', async () => {
  assert.equal((await put({ dashboard_today_glance: false })).status, 200);
  assert.equal((await get()).body.data.dashboard_today_glance, false);
  assert.equal((await put({ dashboard_today_glance: true })).status, 200);
  assert.equal((await get()).body.data.dashboard_today_glance, true);
});
test('dashboard_today_glance braucht keine Adminrechte - wie die Widgets daneben', async () => {
  // Die Uebersicht ist eine gemeinsame Seite; wer ihre Kacheln umstellen darf,
  // darf auch ihr Kopfband abstellen. Waere das eine Admin-Entscheidung, muesste
  // es dashboard_widgets auch sein.
  const res = await put({ dashboard_today_glance: false }, { role: 'member', userId: 2 });
  assert.equal(res.status, 200);
  assert.equal((await get({ role: 'member', userId: 2 })).body.data.dashboard_today_glance, false);
  await put({ dashboard_today_glance: true });
});

test('PUT dashboard_widgets: Teilmenge bleibt beim GET eine Teilmenge', async () => {
  const requested = [{ id: 'notes', visible: false, order: 0, size: '2x1' }];
  const saved = await put({ dashboard_widgets: requested });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.dashboard_widgets, requested);
  assert.deepEqual((await get()).body.data.dashboard_widgets, requested);
});
test('PUT dashboard_widgets: zukünftige sichere Widget-ID wird unverändert persistiert', async () => {
  const requested = [
    { id: 'weather', visible: true, order: 0, size: '2x1' },
    { id: 'solar-production', visible: true, order: 1, size: '2x1' },
  ];

  const saved = await put({ dashboard_widgets: requested });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.dashboard_widgets, requested);
  assert.deepEqual((await get()).body.data.dashboard_widgets, requested);
});
test('PUT dashboard_widgets: aktuelle 13-Widget-Konfiguration bleibt beim GET erhalten', async () => {
  const requested = [
    { id: 'weather', visible: true, order: 0, size: '2x1' },
    { id: 'tasks', visible: true, order: 1, size: '2x2' },
    { id: 'calendar', visible: true, order: 2, size: '2x2' },
    { id: 'notes', visible: true, order: 3, size: '2x1' },
    { id: 'shopping', visible: true, order: 4, size: '2x1' },
    { id: 'birthdays', visible: true, order: 5, size: '1x1' },
    { id: 'family', visible: true, order: 6, size: '1x1' },
    { id: 'meals', visible: true, order: 7, size: '1x1' },
    { id: 'budget', visible: true, order: 8, size: '1x1' },
    { id: 'rewards', visible: true, order: 9, size: '1x2' },
    { id: 'health', visible: true, order: 10, size: '2x1' },
    { id: 'cycle', visible: false, order: 11, size: '2x1' },
    { id: 'housekeeping', visible: true, order: 12, size: '1x1' },
  ];

  const saved = await put({ dashboard_widgets: requested });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.dashboard_widgets, requested);
  assert.deepEqual((await get()).body.data.dashboard_widgets, requested);
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
// --------------------------------------------------------
// Zyklus: haushaltweiter Schalter + persoenliches Opt-out (#760)
// --------------------------------------------------------
test('PUT health_cycle_enabled_user: Mitglied darf fuer sich abschalten, kein Admin-Gate (#760)', async () => {
  // Das Gegenstueck zum Test darueber: derselbe Tab, aber die eigene Sicht -
  // und die darf ein Mitglied ohne Adminrechte aendern.
  assert.equal((await put({ health_cycle_enabled_user: 'no' }, { role: 'member' })).status, 400);
  const res = await put({ health_cycle_enabled_user: false }, { role: 'member', userId: 7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.health_cycle_enabled_user, false);
  assert.equal(res.body.data.health_cycle_effective, false);
  cfgDelete('health_cycle_enabled:user:7');
});

test('health_cycle_effective verundet Haushalt und Person, das Opt-out weitet nie (#760)', async () => {
  cfgDelete('health_cycle_enabled');
  cfgDelete('health_cycle_enabled:user:7');

  // Beide an (Default): der Tab erscheint.
  let data = (await get({ role: 'member', userId: 7 })).body.data;
  assert.deepEqual(
    [data.health_cycle_enabled, data.health_cycle_enabled_user, data.health_cycle_effective],
    [true, true, true],
  );

  // Nur persoenlich aus: der Haushalt bleibt an, meine Sicht nicht.
  await put({ health_cycle_enabled_user: false }, { role: 'member', userId: 7 });
  data = (await get({ role: 'member', userId: 7 })).body.data;
  assert.deepEqual(
    [data.health_cycle_enabled, data.health_cycle_enabled_user, data.health_cycle_effective],
    [true, false, false],
  );

  // Haushalt aus, persoenlich WIEDER an: das Opt-out kann den Admin-Schalter
  // nicht ueberstimmen - sonst holte sich jeder einen abgeschalteten Tab zurueck.
  cfgSet('health_cycle_enabled', '0');
  await put({ health_cycle_enabled_user: true }, { role: 'member', userId: 7 });
  data = (await get({ role: 'member', userId: 7 })).body.data;
  assert.deepEqual(
    [data.health_cycle_enabled, data.health_cycle_enabled_user, data.health_cycle_effective],
    [false, true, false],
  );

  cfgDelete('health_cycle_enabled');
  cfgDelete('health_cycle_enabled:user:7');
});

test('das Zyklus-Opt-out gilt pro Person, nicht fuer den Haushalt (#760)', async () => {
  cfgDelete('health_cycle_enabled');
  await put({ health_cycle_enabled_user: false }, { role: 'member', userId: 7 });

  assert.equal((await get({ role: 'member', userId: 7 })).body.data.health_cycle_effective, false);
  assert.equal((await get({ role: 'member', userId: 8 })).body.data.health_cycle_effective, true);
  // Und der haushaltweite Schalter bleibt davon unberuehrt.
  assert.equal((await get({ role: 'admin' })).body.data.health_cycle_enabled, true);

  cfgDelete('health_cycle_enabled:user:7');
});

test('PUT rewards_require_approval: Mitglied -> 403, Admin non-boolean 400, false persist', async () => {
  assert.equal((await put({ rewards_require_approval: false }, { role: 'member' })).status, 403);
  assert.equal((await put({ rewards_require_approval: 'no' }, { role: 'admin' })).status, 400);
  assert.equal((await put({ rewards_require_approval: false }, { role: 'admin' })).body.data.rewards_require_approval, false);
});
test('PUT tasks_subtasks_expanded: Mitglied -> 403, Admin non-boolean 400, true persist', async () => {
  assert.equal((await put({ tasks_subtasks_expanded: true }, { role: 'member' })).status, 403);
  assert.equal((await put({ tasks_subtasks_expanded: 'yes' }, { role: 'admin' })).status, 400);
  assert.equal((await put({ tasks_subtasks_expanded: true }, { role: 'admin' })).body.data.tasks_subtasks_expanded, true);
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
  // Neben AT/DE aus dem gestubbten API-Ergebnis erscheinen die sechs lokal
  // berechneten Laender aus #965 (Australia, Brazil, Canada, New Zealand,
  // United Kingdom, United States) - alle nach Name eingesortiert.
  assert.deepEqual(res.body.data.map((c) => c.isoCode),
    ['AU', 'AT', 'BR', 'CA', 'DE', 'NZ', 'GB', 'US']);
  holidays.__setFetchImpl(null);
});
test('GET /holidays/countries: API-Fehler -> 200 mit den lokalen Laendern (#965 Review)', async () => {
  // Vorher wurde aus dem Fetch-Fehler ein 502 und das Frontend fiel auf eine
  // leere Liste zurueck - ausgerechnet die sechs Laender, die gar kein Netz
  // brauchen, waren dann nicht mehr waehlbar. Der Service degradiert jetzt auf
  // seine lokale Liste statt zu werfen.
  holidays.__setFetchImpl(async () => { throw new Error('network down'); });
  const res = await raw('GET', '/holidays/countries');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((c) => c.isoCode), ['AU', 'BR', 'CA', 'NZ', 'GB', 'US']);
  assert.ok(res.body.data.every((c) => c.schoolHolidays === false));
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
  // BEIDE Ablagen, seit die Anordnung persönlich ist (#585): der Haushaltswert
  // ist nur noch Fallback, und ein persönlicher Wert verdeckt ihn. Wer hier nur
  // den Haushaltswert korrumpiert, prüft nach dem ersten PUT dieser Datei gar
  // nichts mehr - die Antwort käme dann aus `dashboard_widgets:user:1`.
  cfgDelete('dashboard_widgets:user:1');
  cfgSet('dashboard_widgets', '{ kaputt');
  assert.deepEqual((await get()).body.data.dashboard_widgets, []); // Client erweitert leer auf seine Defaults
  cfgDelete('dashboard_widgets');

  cfgSet('dashboard_widgets:user:1', '{ auch kaputt');
  assert.deepEqual((await get()).body.data.dashboard_widgets, []);
  cfgDelete('dashboard_widgets:user:1');
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
