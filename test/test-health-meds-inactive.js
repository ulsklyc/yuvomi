/**
 * Modul: Health-Test - ein abgeschaltetes Medikament ist nirgends faellig (#1950)
 * Zweck: Die Gesundheitsseite baute "Heute faellig" aus den Plaenen JEDES
 *        Medikaments ihrer Liste, abgeschaltete eingeschlossen. Die Startseite
 *        (`server/routes/dashboard.js`) und der Erinnerungslauf lassen ein
 *        abgeschaltetes Medikament aus - die Seite nannte also eine offene
 *        Dosis, zu der die Kachel der Startseite "nichts offen" sagte.
 *
 *        Gemessen wird am ECHTEN Code auf beiden Seiten, nicht am Quelltext:
 *
 *        - Server: der echte Health-Router und der echte Dashboard-Router ueber
 *          einer migrierten In-Memory-DB. Die Medikamente entstehen ueber die
 *          API, das Abschalten ist ein PATCH - genau der Weg der Oberflaeche.
 *        - Seite: die Renderer aus `public/pages/health.js`, gefuettert mit dem,
 *          was die Seite laedt (`GET /medications`, je Medikament Plaene und
 *          Dosen - dieselben Abrufe wie `loadMeds()`/`loadOverview()`).
 *
 *        Die Uhr steht fest (Montag, 05.10.2026, 12:00 in Berlin) und die Zone
 *        ist auf beiden Seiten die des Haushalts, nicht die des Rechners.
 *
 * Ausfuehren: npm run test:health-meds
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'health-meds-inactive-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { __test: page } = await import('../public/pages/health.js');
const { currentSchedules, medicationCountsToday } = await import('../public/utils/health-meds.js');
const tzClient = await import('/utils/timezone.js');

const ZONE = 'Europe/Berlin';
// Montag, 05.10.2026, 12:00 in Berlin.
const NOON = '2026-10-05T10:00:00Z';
const TODAY = '2026-10-05';

function buildMigratedDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(database); else database.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(ZONE);
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase();
_setTestDatabase(db);
moduleDatabase.close();

const ANNA = Number(db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('anna-1950', 'Anna', '$2b$12$x', 'admin')`).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(ANNA);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/dashboard', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  assert.ok(res.status < 300, `${method} ${path} -> ${res.status} ${text}`);
  return json;
}

/** Ein Medikament mit einem taeglichen Plan um 18:00, angelegt wie in der Oberflaeche. */
async function addMedication(name) {
  const med = (await call('POST', '/health/medications', { name })).data;
  const schedule = (await call('POST', `/health/medications/${med.id}/schedules`, { time_of_day: '18:00' })).data;
  return { id: med.id, scheduleId: schedule.id };
}

async function logTaken(med, day) {
  await call('POST', `/health/medications/${med.id}/logs`, {
    schedule_id: med.scheduleId, scheduled_at: `${day}T18:00`, status: 'taken', taken_at: `${day}T18:05`,
  });
}

/** Was die Seite fuer eine Person laedt - dieselben Abrufe wie `loadMeds()` und `loadOverview()`. */
async function loadLikeThePage(from) {
  const list = (await call('GET', `/health/medications?user_id=${ANNA}`)).data;
  const schedulesByMed = {};
  const logsByMed = {};
  for (const m of list) {
    schedulesByMed[m.id] = (await call('GET', `/health/medications/${m.id}/schedules`)).data;
    logsByMed[m.id] = (await call('GET', `/health/medications/${m.id}/logs?from=${from}T00:00&to=${TODAY}T23:59`)).data;
  }
  return { list, schedulesByMed, logsByMed };
}

const namesIn = (html) => [...html.matchAll(/health-dose__name">([^<·]*)/g)].map(([, name]) => name.trim());

/**
 * Der Haushalt des Issues: ein aktives und ein abgeschaltetes Medikament, beide
 * mit Plan fuer heute. Das abgeschaltete wurde gestern noch genommen.
 */
async function withHousehold(fn) {
  db.prepare('DELETE FROM medications').run();
  mock.timers.enable({ apis: ['Date'], now: new Date(NOON) });
  tzClient.setDisplayTimeZone(ZONE);
  try {
    const ramipril = await addMedication('Ramipril');
    const amoxicillin = await addMedication('Amoxicillin');
    // Ramipril an den sechs Tagen vor heute genommen, Amoxicillin nur gestern.
    for (const day of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      await logTaken(ramipril, day);
    }
    await logTaken(amoxicillin, '2026-10-04');
    // Abschalten wie im Formular: das Haekchen "Aktiv" geht raus.
    await call('PATCH', `/health/medications/${amoxicillin.id}`, { active: false });

    const medsTab = await loadLikeThePage('2026-09-29'); // 7 Tage, wie der Medikamenten-Reiter
    const overview = await loadLikeThePage('2026-09-06'); // 30 Tage, wie die Uebersicht
    page.setViewStateForTest('meds', { ...medsTab, personId: ANNA, meId: ANNA });
    page.setViewStateForTest('overview', {
      meds: overview.list, schedulesByMed: overview.schedulesByMed, logsByMed: overview.logsByMed,
      personId: ANNA, meId: ANNA,
    });
    await fn({ medsTab, ramipril, amoxicillin });
  } finally {
    page.setViewStateForTest('meds', { list: [], schedulesByMed: {}, logsByMed: {}, personId: null, meId: null });
    page.setViewStateForTest('overview', { meds: [], schedulesByMed: {}, logsByMed: {}, personId: null, meId: null });
    tzClient.setDisplayTimeZone(null);
    mock.timers.reset();
  }
}

test('#1950: ein abgeschaltetes Medikament ist auf der Gesundheitsseite heute nicht faellig', () => withHousehold(async ({ medsTab, amoxicillin }) => {
  // REICHWEITE: der Fall des Issues liegt wirklich vor. Die Seite laedt das
  // abgeschaltete Medikament mit (die Liste traegt keinen `active`-Filter), und
  // sein Plan ist selbst weiter aktiv - abgeschaltet ist das MEDIKAMENT.
  assert.deepEqual(medsTab.list.map((m) => [m.name, m.active]), [['Ramipril', 1], ['Amoxicillin', 0]]);
  assert.equal(medsTab.schedulesByMed[amoxicillin.id].length, 1);
  assert.equal(medsTab.schedulesByMed[amoxicillin.id][0].active, 1);

  assert.deepEqual(namesIn(page.dueTodayMarkup()), ['Ramipril'],
    'Medikamenten-Reiter: "Heute faellig" nennt nur das aktive Medikament');
  assert.deepEqual(namesIn(page.overviewDueMarkup()), ['Ramipril'],
    'Modul-Uebersicht: "Heute faellig" nennt nur das aktive Medikament');
  assert.deepEqual(namesIn(page.overviewUpcomingMarkup()), ['Ramipril'],
    'Modul-Uebersicht: die naechsten Erinnerungen nennen nur das aktive Medikament');
}));

test('#1950: Gesundheitsseite und Kachel der Startseite zaehlen fuer dieselbe Person und denselben Tag gleich', () => withHousehold(async () => {
  const tile = (await call('GET', '/dashboard')).health;
  assert.equal(tile.dosesTotal, 1, 'Reichweite: die Startseite zaehlt die eine Dosis des aktiven Medikaments');
  assert.equal(namesIn(page.dueTodayMarkup()).length, tile.dosesTotal, 'Medikamenten-Reiter gegen die Startseite');
  assert.equal(namesIn(page.overviewDueMarkup()).length, tile.dosesTotal, 'Modul-Uebersicht gegen die Startseite');
}));

test('#1950: das abgeschaltete Medikament bleibt in der Liste, seine genommenen Dosen im Protokoll', () => withHousehold(async () => {
  const cards = page.medListMarkup();
  assert.match(cards, /Ramipril/);
  assert.match(cards, /Amoxicillin/, 'die Karte des abgeschalteten Medikaments bleibt stehen');
  assert.equal((cards.match(/health\.meds\.badge\.inactive/g) || []).length, 1, 'und traegt das Abzeichen "inaktiv"');
  assert.match(page.medLogHistoryMarkup(), /Amoxicillin/,
    'die gestern genommene Dosis steht weiter im Einnahmeprotokoll');
}));

test('#1950: die Einnahmetreue misst die Medikamente, die heute zaehlen - auf beiden Flaechen dieselbe Zahl', () => withHousehold(async () => {
  // Ramipril: sieben geplante Dosen im Fenster, sechs genommen (heute steht
  // noch aus). Vor dem Fix standen die sieben nie genommenen Dosen des
  // abgeschalteten Amoxicillins mit im Nenner (7 von 14, also 50 %), und die
  // Serie riss an jedem Tag, an dem es "fehlte".
  const pct = (html, cls) => html.match(new RegExp(`${cls}">(\\d+)%`))?.[1];
  assert.equal(pct(page.adherenceMarkup(), 'metric-card__value'), '86', 'Medikamenten-Reiter: sechs von sieben');
  const overview = page.overviewAdherenceMarkup();
  assert.equal(pct(overview, 'health-overview__stat-value'), '86', 'Modul-Uebersicht: dieselbe Zahl');
  assert.match(overview, /health-overview__streak-icon[^>]*><\/i>\s*6\s*</, 'die Serie zaehlt die sechs eingehaltenen Tage');
}));

test('#1950: die Regel steht einmal - `medicationCountsToday` und `currentSchedules`', () => {
  assert.equal(medicationCountsToday({ id: 1, active: 1 }), true);
  assert.equal(medicationCountsToday({ id: 1, active: true }), true);
  assert.equal(medicationCountsToday({ id: 1, active: 0 }), false);
  assert.equal(medicationCountsToday({ id: 1, active: false }), false);
  assert.equal(medicationCountsToday(null), false);
  const plans = currentSchedules(
    [{ id: 1, active: 1 }, { id: 2, active: 0 }, { id: 3, active: 1 }],
    { 1: [{ id: 10, medication_id: 1 }], 2: [{ id: 20, medication_id: 2 }] },
  );
  assert.deepEqual(plans.map((s) => s.id), [10], 'nur die Plaene der zaehlenden Medikamente; ohne Plan kein Eintrag');
});
