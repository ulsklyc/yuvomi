/**
 * Modul: Holidays-Test (Feiertage & Schulferien)
 * Zweck: Validiert den Holiday-Service – Cache-Lese-Pfad (getForRange) mit
 *        Datumsüberlappung, Layer-Toggles, Subdivision-Matching und Farb-
 *        Zuordnung; sowie sync()/getCountries()/getSubdivisions() gegen eine
 *        gemockte OpenHolidays-API (kein Netzwerk).
 * Ausführen: node --experimental-sqlite test/test-holidays.js
 */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, _setTestDatabase, _resetTestDatabase } from '../server/db.js';
import { sync, getForRange, getCountries, getSubdivisions, getGroups, __setFetchImpl, __test } from '../server/services/holidays.js';

const { localHolidayFallback } = __test;
// Nur die Daten - fuer Fixture-Vergleiche ausreichend und stabiler gegenueber
// Umbau der internen Sortierung als ein voller Objektabgleich.
const namesAndDates = (year, country, subdivision) =>
  localHolidayFallback(country, 'public', year, 'EN', subdivision)
    .map((h) => `${h.startDate} ${h.name}`)
    .sort();

// In-Memory-DB mit allen Migrationen (inkl. v49 holiday_cache) aufbauen.
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

// ---- Helpers ----------------------------------------------------------------

function resetState() {
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'holiday_%'").run();
  // AUCH DIE DATENSPRACHE, und das ist keine Kosmetik: seit #946 entscheidet
  // sie, in welcher Sprache die Namen im Cache landen. Bliebe sie zwischen
  // zwei Tests stehen, haetten die Erwartungen des einen die Voraussetzung des
  // naechsten gesetzt - der ganze Rest der Suite haenge dann an der Reihenfolge.
  db.prepare("DELETE FROM sync_config WHERE key IN ('language', 'region')").run();
  db.prepare('DELETE FROM holiday_cache').run();
}

function setConfig(cfg) {
  const set = db.prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    set.run(k, String(v));
  }
}

function seedHoliday({ type, country = 'DE', subdivision = null, group = null, start, end, name = 'Test', year }) {
  db.prepare(`INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year, group_code)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, country, subdivision, start, end, name, year ?? Number(start.slice(0, 4)), group);
}

const okJson = (data) => ({ ok: true, json: async () => data });

// Fängt alle console-Kanäle ab, damit ein Lauf beobachtbar wird, welche
// Log-Level der Service tatsächlich benutzt. Der Logger schreibt debug über
// console.log und info über console.info (server/logger.js), sodass eine
// leere info-Liste beweist: nichts landet im Standard-Log-Level.
async function captureConsole(fn) {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const lines = { log: [], info: [], warn: [], error: [] };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines[level].push(args.join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

// fetch-Mock, das je nach OpenHolidays-Endpoint deterministische Daten liefert.
function makeApiMock() {
  const calls = [];
  const fn = async (url) => {
    const s = String(url);
    calls.push(s);
    const path = new URL(s).pathname;
    const country = new URL(s).searchParams.get('countryIsoCode');
    if (path === '/PublicHolidays') {
      // Alle lokal berechneten Laender aus #965: OpenHolidays kennt sie nicht
      // (oder liefert wie bei BR real eine leere Antwort) - derselbe
      // "erfolgreich, aber leer" Pfad wie beim urspruenglichen Brasilien-Fall.
      if (['BR', 'US', 'CA', 'GB', 'AU', 'NZ'].includes(country)) return okJson([]);
      // Spanien wie in #946: die Landessprache steht ZUERST im Array, Englisch
      // weiter hinten - und "Reyes" fuehrt die API nur auf Spanisch und
      // Katalanisch. So laesst sich beides pruefen: die Wahl der Wunschsprache
      // und der Rueckfall, wenn es sie nicht gibt.
      if (country === 'ES') {
        return okJson([
          { startDate: '2026-12-25', endDate: '2026-12-25',
            name: [
              { language: 'ES', text: 'Navidad' },
              { language: 'CA', text: 'Nadal' },
              { language: 'EN', text: 'Christmas Day' },
              { language: 'DE', text: 'Weihnachtstag' },
            ] },
          { startDate: '2026-01-06', endDate: '2026-01-06',
            name: [
              { language: 'ES', text: 'Reyes' },
              { language: 'CA', text: 'Reis' },
            ] },
          // Weder Deutsch noch die Landessprache zuerst-genommen: dieser
          // Eintrag trennt die mittlere Stufe der Kaskade (Englisch) von der
          // letzten (die erste angebotene). Ohne ihn waeren beide Fassungen
          // gleich und ein Test darueber bewiese nichts.
          { startDate: '2026-05-01', endDate: '2026-05-01',
            name: [
              { language: 'ES', text: 'Fiesta del Trabajo' },
              { language: 'CA', text: 'Festa del Treball' },
              { language: 'EN', text: 'Labour Day' },
            ] },
        ]);
      }
      return okJson([{ startDate: '2026-01-01', endDate: '2026-01-01',
        name: [{ language: 'DE', text: 'Neujahr' }, { language: 'EN', text: "New Year's Day" }] }]);
    }
    if (path === '/SchoolHolidays') {
      // Keins der #965-Laender hat eine Schulferien-Quelle (real nicht bei
      // OpenHolidays gefuehrt) - der Mock muss das nachbilden, sonst wuerde er
      // faelschlich deutsche Sommerferien fuer z. B. die USA zurueckgeben.
      if (['BR', 'US', 'CA', 'GB', 'AU', 'NZ'].includes(country)) return okJson([]);
      return okJson([
        { startDate: '2026-07-20', endDate: '2026-08-30',
          name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer break' }] },
        // Sub-regionale Insel-Ausnahme (Sylt/Föhr/…): abweichendes Enddatum,
        // von OpenHolidays mit "Exception" getaggt – muss verworfen werden (#434).
        { startDate: '2026-07-20', endDate: '2026-08-23', tags: ['Exception'],
          name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer break' }] },
      ]);
    }
    if (path === '/Countries') {
      return okJson([
        { isoCode: 'DE', name: [{ language: 'EN', text: 'Germany' }, { language: 'DE', text: 'Deutschland' }] },
        { isoCode: 'FR', name: [{ language: 'EN', text: 'France' }] },
      ]);
    }
    if (path === '/Subdivisions') {
      return okJson([
        { isoCode: 'DE-BY', name: [{ language: 'EN', text: 'Bavaria' }, { language: 'DE', text: 'Bayern' }] },
        { code: 'DE-BW', name: [], shortName: 'BW' },
      ]);
    }
    return okJson([]);
  };
  fn.calls = calls;
  return fn;
}

const SYNC_YEAR_SPAN = 4; // currentYear-1 .. currentYear+2
const BRAZIL_PUBLIC_HOLIDAYS_PER_YEAR = 10;

beforeEach(() => { resetState(); __setFetchImpl(null); });

// ---- getForRange -------------------------------------------------------------

test('getForRange: [] when no country configured', () => {
  setConfig({ holiday_show_public: '1' });
  assert.deepEqual(getForRange('2026-01-01', '2026-12-31'), []);
});

test('getForRange: [] when both layers disabled', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-01' });
  assert.deepEqual(getForRange('2026-01-01', '2026-12-31'), []);
});

test('getForRange: returns public holiday with configured public color', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_public_color: '#AA0000' });
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  const rows = getForRange('2026-01-01', '2026-01-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'public');
  assert.equal(rows[0].name, 'Neujahr');
  assert.equal(rows[0].color, '#AA0000');
});

test('getForRange: school holiday uses the school color, not the public one', () => {
  setConfig({ holiday_country: 'DE', holiday_show_school: '1',
    holiday_public_color: '#AA0000', holiday_school_color: '#00AA00' });
  seedHoliday({ type: 'school', start: '2026-07-20', end: '2026-08-30', name: 'Sommerferien' });
  const rows = getForRange('2026-08-01', '2026-08-10');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].color, '#00AA00');
});

test('getForRange: date overlap – includes spanning ranges, excludes outside ones', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1' });
  seedHoliday({ type: 'public', start: '2025-12-31', end: '2025-12-31', name: 'Silvester' }); // before
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-06', name: 'Spanning' });   // overlaps start edge
  seedHoliday({ type: 'public', start: '2026-06-15', end: '2026-06-15', name: 'Inside' });      // inside
  seedHoliday({ type: 'public', start: '2027-01-01', end: '2027-01-01', name: 'After' });        // after
  const names = getForRange('2026-01-05', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Inside', 'Spanning']);
});

test('getForRange: type toggle hides school when only public is enabled', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  seedHoliday({ type: 'public', start: '2026-05-01', end: '2026-05-01', name: 'Labour Day' });
  seedHoliday({ type: 'school', start: '2026-05-01', end: '2026-05-10', name: 'May break' });
  const rows = getForRange('2026-05-01', '2026-05-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'public');
});

test('getForRange: subdivision – national + matching region shown, other region hidden', () => {
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_show_public: '1' });
  seedHoliday({ type: 'public', subdivision: null,    start: '2026-10-03', end: '2026-10-03', name: 'National' });
  seedHoliday({ type: 'public', subdivision: 'DE-BY', start: '2026-11-01', end: '2026-11-01', name: 'Bavaria only' });
  seedHoliday({ type: 'public', subdivision: 'DE-BW', start: '2026-11-01', end: '2026-11-01', name: 'BW only' });
  const names = getForRange('2026-01-01', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Bavaria only', 'National']);
});

test('getForRange: collapses identical holidays left over from an old scope – no duplicates (#434)', () => {
  // Simuliert einen Alt-Cache aus der Zeit vor dem DELETE-all-Fix: derselbe
  // Feiertag liegt sowohl im länderweiten (NULL-) als auch im heutigen
  // Regions-Scope. Der Kalender darf ihn trotzdem nur einmal anzeigen.
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-SH', holiday_show_public: '1' });
  seedHoliday({ type: 'public', subdivision: null,    start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  seedHoliday({ type: 'public', subdivision: 'DE-SH', start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  seedHoliday({ type: 'public', subdivision: '',      start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  const rows = getForRange('2026-01-01', '2026-12-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Neujahr');
});

test('getForRange: collapses overlapping same-name school variants into one union span (#434, CH-BE)', () => {
  // OpenHolidays liefert für Kanton Bern zwei "Sommerferien" mit abweichenden
  // Terminen (deutsch- vs. französischsprachige Schulregion, groups CH-BE-VS/-EO).
  // Kein "Exception"-Tag, unterschiedliche Daten → beide landen im Cache. Der
  // Kalender darf trotzdem nur EINEN Balken zeigen: die Union-Spanne.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE',
    start: '2026-07-04', end: '2026-08-09', name: 'Sommerferien' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE',
    start: '2026-07-06', end: '2026-08-14', name: 'Sommerferien' });

  const rows = getForRange('2026-07-01', '2026-08-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Sommerferien');
  assert.equal(rows[0].start_date, '2026-07-04'); // frühester Start
  assert.equal(rows[0].end_date, '2026-08-14');   // spätestes Ende
});

test('getForRange: keeps non-overlapping same-name entries separate (movable days)', () => {
  // Gleichnamige, aber zeitlich getrennte Einträge (z. B. mehrere bewegliche
  // Ferientage) dürfen NICHT zu einer Monatsspanne verschmolzen werden.
  setConfig({ holiday_country: 'CH', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', start: '2026-03-02', end: '2026-03-02', name: 'Ferientag' });
  seedHoliday({ type: 'school', country: 'CH', start: '2026-06-15', end: '2026-06-15', name: 'Ferientag' });
  const rows = getForRange('2026-01-01', '2026-12-31');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.start_date), ['2026-03-02', '2026-06-15']);
});

// ---- Schulferien-Gruppen (#434) ---------------------------------------------

test('getForRange: configured group shows only that regime, not the union (#434, CH-BE-VS)', () => {
  // Deutschsprachiger Kantonsteil (CH-BE-VS) endet am 09.08.; die
  // französischsprachige Variante (CH-BE-EO) bis 14.08. muss ausgeblendet
  // bleiben, statt zu einer falschen Union-Spanne zu verschmelzen.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE',
    holiday_group: 'CH-BE-VS', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-VS',
    start: '2026-07-04', end: '2026-08-09', name: 'Sommerferien' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-EO',
    start: '2026-07-06', end: '2026-08-14', name: 'Sommerferien' });

  const rows = getForRange('2026-07-01', '2026-08-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].end_date, '2026-08-09'); // nur das VS-Regime
});

test('getForRange: configured group still shows group-less rows (public holidays) (#434)', () => {
  // Feiertage tragen keine Gruppe (group_code NULL) und gelten für die ganze
  // Subdivision – sie dürfen trotz gewählter Schulferien-Gruppe erscheinen.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE',
    holiday_group: 'CH-BE-EO', holiday_show_public: '1', holiday_show_school: '1' });
  seedHoliday({ type: 'public', country: 'CH', subdivision: 'CH-BE', group: null,
    start: '2026-08-01', end: '2026-08-01', name: 'Bundesfeier' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-VS',
    start: '2026-01-31', end: '2026-02-08', name: 'Februarwoche' }); // nur VS
  const names = getForRange('2026-01-01', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Bundesfeier']); // Februarwoche (VS) ausgeblendet
});

test('getGroups: returns groups for a multilingual subdivision, sorted', async () => {
  __setFetchImpl(async (url) => {
    assert.equal(new URL(String(url)).pathname, '/Subdivisions');
    return okJson([
      { code: 'CH-BE', name: [], shortName: 'BE', groups: [
        { code: 'CH-BE-VS', shortName: 'BE-VS' },
        { code: 'CH-BE-EO', shortName: 'BE-EO' },
      ] },
      { code: 'CH-ZH', name: [], shortName: 'ZH', groups: [] },
    ]);
  });
  const groups = await getGroups('CH', 'CH-BE');
  assert.deepEqual(groups, [
    { code: 'CH-BE-EO', name: 'BE-EO' },
    { code: 'CH-BE-VS', name: 'BE-VS' },
  ]);
});

test('getGroups: [] for a subdivision without groups', async () => {
  __setFetchImpl(async () => okJson([
    { code: 'CH-ZH', name: [], shortName: 'ZH', groups: [] },
  ]));
  assert.deepEqual(await getGroups('CH', 'CH-ZH'), []);
});

test('sync: stores group_code from the OpenHolidays groups field (#434)', async () => {
  __setFetchImpl(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/SchoolHolidays') {
      return okJson([
        { startDate: '2026-07-04', endDate: '2026-08-09',
          name: [{ language: 'DE', text: 'Sommerferien' }], groups: [{ code: 'CH-BE-VS' }] },
        { startDate: '2026-07-06', endDate: '2026-08-14',
          name: [{ language: 'DE', text: 'Sommerferien' }], groups: [{ code: 'CH-BE-EO' }] },
      ]);
    }
    return okJson([]);
  });
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_show_school: '1' });
  await sync(true);
  const stored = db.prepare(
    "SELECT group_code FROM holiday_cache WHERE end_date = '2026-08-09'",
  ).get();
  assert.equal(stored.group_code, 'CH-BE-VS');
});

// ---- sync --------------------------------------------------------------------

test('sync: no country → no fetch, synced 0', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const res = await sync();
  assert.deepEqual(res, { synced: 0 });
  assert.equal(mock.calls.length, 0);
});

test('sync: both layers off → no fetch, synced 0', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  const res = await sync();
  assert.deepEqual(res, { synced: 0 });
  assert.equal(mock.calls.length, 0);
});

// Die drei Skip-Pfade laufen bei jedem Scheduler-Tick. Sie dürfen im
// Standard-Log-Level (info) nichts ausgeben, sonst rauscht das Log zu.
test('sync: no country → schweigt im Standard-Log-Level', async () => {
  __setFetchImpl(makeApiMock());
  const lines = await captureConsole(() => sync());
  assert.deepEqual(lines.info, []);
});

test('sync: both layers off → schweigt im Standard-Log-Level', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  const lines = await captureConsole(() => sync());
  assert.deepEqual(lines.info, []);
});

test('sync: throttled run → schweigt im Standard-Log-Level', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({
    holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0',
    holiday_last_sync: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    // Seit #946 gilt die Sperre nur, solange die Sprache dieselbe ist wie beim
    // letzten Lauf. Ohne diese Zeile HAETTE der Lauf zu recht gefetcht - der
    // Cache stuende dann in einer anderen Sprache als der eingestellten.
    holiday_last_sync_scope: 'EN|DE||P|',
  });
  const lines = await captureConsole(() => sync());
  assert.equal(mock.calls.length, 0, 'throttled run darf nicht fetchen');
  assert.deepEqual(lines.info, []);
});

test('sync: public-only fetches PublicHolidays per year, caches them, sets last_sync', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  // Die Datensprache steht ausdruecklich da: sie - nicht das Land - entscheidet
  // seit #946, welcher Name im Cache landet.
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN);
  assert.ok(mock.calls.every((u) => u.includes('/PublicHolidays')));
  assert.ok(!mock.calls.some((u) => u.includes('/SchoolHolidays')));

  const pub = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(pub, SYNC_YEAR_SPAN);
  // Deutsche Datensprache → deutscher Name aus dem name-Array
  assert.equal(db.prepare('SELECT name FROM holiday_cache LIMIT 1').get().name, 'Neujahr');
  // last_sync persisted
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync'").get()?.value);
});

test('sync: is idempotent – re-running does not duplicate cached rows', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  await sync(true);
  await sync(true);
  const pub = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(pub, SYNC_YEAR_SPAN);
});

test('sync: switching region purges the previous scope – no duplicate holidays (#434)', async () => {
  __setFetchImpl(makeApiMock());
  // 1. Erst länderweit synchronisieren (subdivision NULL → nationale Feiertage).
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  await sync(true);
  // 2. Nutzer wählt danach eine Region und synchronisiert erneut.
  setConfig({ holiday_subdivision: 'DE-SH' });
  await sync(true);

  // Cache darf pro Jahr nur einen Satz enthalten (kein NULL- + Regions-Duplikat).
  const total = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(total, SYNC_YEAR_SPAN);

  // Die veralteten länderweiten (NULL-)Zeilen wurden entfernt; es bleibt nur
  // der aktuell gewählte Regions-Scope übrig.
  const stale = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE subdivision IS NULL").get().c;
  assert.equal(stale, 0);
});

test('sync: both layers enabled caches public and school entries', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '1' });
  const res = await sync(true);
  assert.equal(res.synced, SYNC_YEAR_SPAN * 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c, SYNC_YEAR_SPAN);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c, SYNC_YEAR_SPAN);
});

test('sync: drops "Exception"-tagged sub-regional holiday variants – no duplicate school breaks (#434)', async () => {
  __setFetchImpl(makeApiMock());
  // Schleswig-Holstein: OpenHolidays liefert neben den regulären Sommerferien
  // eine zweite, "Exception"-getaggte Variante mit früherem Enddatum (Inseln).
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-SH',
    holiday_show_public: '0', holiday_show_school: '1' });

  const res = await sync(true);

  // Pro Jahr bleibt nur der reguläre Eintrag – die Insel-Ausnahme wird verworfen.
  assert.equal(res.synced, SYNC_YEAR_SPAN);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c, SYNC_YEAR_SPAN);
  const ends = db.prepare("SELECT DISTINCT end_date FROM holiday_cache WHERE type='school'").all().map((r) => r.end_date);
  assert.deepEqual(ends, ['2026-08-30']); // nur das reguläre Enddatum, nicht 2026-08-23
});

test('sync: Brazil local fallback follows the data language, not the country', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'BR', holiday_show_public: '1', holiday_show_school: '0', language: 'pt' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * BRAZIL_PUBLIC_HOLIDAYS_PER_YEAR);
  // Seit dem Kurzschluss fuer lokal berechnete Laender (#965 Review) fragt ein
  // Nur-Feiertage-Sync fuer BR die API gar nicht mehr - die Zusicherung dieses
  // Tests ist die Sprachkaskade darunter, nicht der Transportweg.
  assert.deepEqual(mock.calls.filter((url) => url.includes('/PublicHolidays')), []);

  const currentYear = new Date().getFullYear();
  const namesOf = () => db.prepare(
    "SELECT name FROM holiday_cache WHERE country='BR' AND type='public' AND year=? ORDER BY start_date"
  ).all(currentYear).map((row) => row.name);
  let names = namesOf();
  assert.ok(names.includes('Tiradentes'));
  assert.ok(names.includes('Dia Nacional de Zumbi e da Consciência Negra'));
  assert.ok(names.includes('Natal'));

  // Derselbe Haushalt, dieselbe Ortsliste - nur die Datensprache wechselt. Der
  // Fallback kennt beide Fassungen; vorher entschied das LAND und Englisch war
  // unerreichbar (#946).
  setConfig({ language: 'en' });
  await sync(true);
  names = namesOf();
  assert.ok(names.includes('Christmas Day'), `EN-Fassung erwartet, bekam: ${names.join(', ')}`);
  assert.ok(!names.includes('Natal'));
});

test('sync: throttles automatic sync if executed within 30 days', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });

  // First sync (force=false) - should run because DB has no last_sync
  const res1 = await sync(false);
  assert.equal(res1.synced, SYNC_YEAR_SPAN);
  const firstCallCount = mock.calls.length;
  assert.ok(firstCallCount > 0);

  // Second sync (force=false) - should throttle (skip)
  const res2 = await sync(false);
  assert.deepEqual(res2, { synced: 0 });
  assert.equal(mock.calls.length, firstCallCount); // no new API calls

  // Third sync (force=true) - should bypass throttle
  const res3 = await sync(true);
  assert.equal(res3.synced, SYNC_YEAR_SPAN);
  assert.equal(mock.calls.length, firstCallCount * 2); // new API calls made
});

// ---- Sprache der gespeicherten Eintraege (#946) ------------------------------

test('sync: die Namen folgen der Datensprache, nicht dem Land (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  // Der gemeldete Fall: Land Spanien, Region Katalonien, Datensprache Englisch.
  // Vorher leitete der Dienst die Sprache aus dem LAND ab und speicherte
  // "Navidad" - auch fuer einen Haushalt, der ausdruecklich Englisch gewaehlt
  // hatte und dem der Hinweis unter dem Feld Wirkung auf die Synchronisierung
  // zusagt.
  setConfig({
    holiday_country: 'ES', holiday_subdivision: 'ES-CT',
    holiday_show_public: '1', holiday_show_school: '0', language: 'en',
  });

  await sync(true);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.ok(namen.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.deepEqual([...new Set(namen)], ['Christmas Day'],
    'die eingestellte Datensprache entscheidet, nicht das Land');
});

test('sync: eine deutsche Datensprache bekommt denselben Feiertag auf Deutsch (#946)', async () => {
  __setFetchImpl(makeApiMock());
  // Die Gegenprobe zum Test darueber: dasselbe Land, dieselbe Region, nur eine
  // andere Datensprache. Ohne sie belegte der Test oben genauso gut einen
  // Dienst, der IMMER Englisch speichert.
  setConfig({
    holiday_country: 'ES', holiday_subdivision: 'ES-CT',
    holiday_show_public: '1', holiday_show_school: '0', language: 'de',
  });

  await sync(true);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual([...new Set(namen)], ['Weihnachtstag']);
});

test('sync: fehlt die Wunschsprache, gilt Englisch vor der ersten angebotenen (#946)', async () => {
  __setFetchImpl(makeApiMock());
  // Der 1. Mai steht im Mock auf Spanisch, Katalanisch und Englisch - nicht auf
  // Deutsch. Die alte Kaskade hiess "Wunsch, sonst die ERSTE", und die erste
  // ist die Landessprache: ein deutscher Haushalt bekam "Fiesta del Trabajo"
  // untergeschoben, obwohl eine englische Fassung danebenlag. Englisch fuehrt
  // OpenHolidays fuer nahezu jedes Land mit und ist damit die bessere Auskunft
  // als "was der Server zufaellig zuerst nennt".
  setConfig({
    holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'de',
  });

  await sync(true);

  const mai = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-05-01'").all().map((r) => r.name);
  assert.ok(mai.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.deepEqual([...new Set(mai)], ['Labour Day'],
    'keine deutsche Fassung, aber eine englische → Englisch, nicht die Landessprache');

  // Und wo es auch kein Englisch gibt, bleibt die erste angebotene der letzte
  // Halt - sonst stuende die Zeile leer da.
  const reyes = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-01-06'").all().map((r) => r.name);
  assert.deepEqual([...new Set(reyes)], ['Reyes']);
});

test('sync: fragt ohne languageIsoCode, damit die Wahl hier faellt (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });

  await sync(true);

  assert.ok(mock.calls.length > 0, 'ohne Abruf prueft die Zusicherung darunter nichts');
  const mitFilter = mock.calls.filter((url) => url.includes('languageIsoCode'));
  assert.deepEqual(mitFilter, [],
    'Mit languageIsoCode liefert OpenHolidays je Feiertag nur EINEN Namen - und wenn es\n'
    + 'den in der gefragten Sprache nicht gibt, den der Landessprache. Die Kaskade in\n'
    + 'resolveName laeuft dann ueber ein einelementiges Array und kann nichts mehr waehlen.');
});

test('sync: ein Sprachwechsel bricht die 30-Tage-Sperre (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });

  await sync(true);
  const nachErstem = mock.calls.length;
  assert.ok(nachErstem > 0);

  // Gleiche Sprache: die Sperre greift wie bisher.
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(mock.calls.length, nachErstem, 'ohne Sprachwechsel bleibt es beim Bestand');

  // Andere Sprache: die Namen im Cache stehen in der falschen Sprache, also
  // muss der Lauf durch. Sonst saehe der Haushalt bis zu einen Monat lang
  // weiter die alten Namen und meldete den Fehler zu recht erneut.
  setConfig({ language: 'de' });
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein Sprachwechsel muss den Bestand erneuern');
  assert.ok(mock.calls.length > nachErstem);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual([...new Set(namen)], ['Weihnachtstag']);
  assert.ok(
    db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value?.startsWith('DE|ES|'),
    'der benutzte Scope steht neben dem Zeitstempel, sonst laeuft jeder Lauf erneut durch',
  );
});

test('sync: ein gescheiterter Lauf schreibt die Sprache NICHT fest (#946)', async () => {
  // GEFUNDEN VON CODEX UND claude-review, unabhaengig voneinander. Der
  // Sprach-Merker stand unbedingt nach der Schleife: schlug auch nur ein Jahr
  // fehl, blieb dieser Bereich in der alten Sprache - verbucht wurde der Lauf
  // trotzdem als erledigt, und die 30-Tage-Sperre schrieb den halb
  // uebersetzten Cache fuer einen Monat fest. Dieselbe Sorte Fehler wie ein
  // Sync-Cursor, der ueber einen Fehlschlag hinweglaeuft (#839).
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value?.startsWith('EN|'));

  // Sprachwechsel, aber die API antwortet nicht mehr.
  setConfig({ language: 'de' });
  const kaputt = async () => { throw new Error('network down'); };
  kaputt.calls = [];
  __setFetchImpl(kaputt);
  await captureConsole(() => sync(true));

  assert.equal(
    db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value,
    undefined,
    'ein unvollstaendiger Lauf laesst einen GEMISCHTEN Cache zurueck - kein Scope darf danach als erledigt gelten,\n'
    + 'sonst waere ein Zurueckwechseln auf den alten "unveraendert" und die 30-Tage-Sperre schriebe die halb\n'
    + 'umgestellten Bereiche fuer einen Monat fest',
  );

  // Und der naechste Lauf holt es nach, sobald die API wieder da ist.
  db.prepare("DELETE FROM sync_config WHERE key='holiday_retry_after'").run();
  __setFetchImpl(makeApiMock());
  const res = await sync(false);
  assert.ok(res.synced > 0, 'der offene Sprachwechsel muss beim naechsten Lauf greifen');
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value?.startsWith('DE|'));
});

test('sync: nach einem Fehlschlag wird der Nachlauf gebremst, nicht wiederholt gehaemmert (#946)', async () => {
  // Der Scheduler laeuft alle 15 Minuten (SYNC_INTERVAL_MINUTES). Bliebe der
  // Sprach-Merker offen UND ungebremst, liefe bei einem Ausfall der Fremd-API
  // rund um die Uhr alle 15 Minuten ein neuer Anlauf gegen einen kostenlosen
  // Fremddienst. Gebremst wird NUR der Wiederholungsversuch - ein frischer
  // Sprachwechsel wirkt weiterhin sofort, sonst waere die Bremse genau die
  // Verzoegerung, die dieser Nachlauf abschaffen sollte.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  setConfig({ language: 'de' });
  const kaputt = async () => { throw new Error('network down'); };
  __setFetchImpl(kaputt);
  await captureConsole(() => sync(true));

  const gebremstBis = db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value;
  assert.ok(gebremstBis, 'ein Fehlschlag muss eine Wartemarke hinterlassen');
  assert.ok(new Date(gebremstBis).getTime() > Date.now(), 'die Wartemarke liegt in der Zukunft');

  const mock = makeApiMock();
  __setFetchImpl(mock);
  assert.deepEqual(await sync(false), { synced: 0 }, 'solange die Wartemarke gilt, wird nicht erneut gefetcht');
  assert.equal(mock.calls.length, 0);

  // Von Hand ausgeloest (Knopf "Jetzt synchronisieren") gilt die Bremse nicht.
  const res = await sync(true);
  assert.ok(res.synced > 0, 'force muss die Wartemarke uebergehen');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value, undefined,
    'ein geglueckter Lauf raeumt die Wartemarke weg');
});

test('sync: der Brasilien-Ersatz folgt derselben Kaskade wie die API-Namen (#946)', async () => {
  // Die Ersatzliste kennt nur PT und EN. Ihr Rueckfall stand auf PT - was fuer
  // einen brasilianischen Haushalt richtig aussieht, aber der Zusage
  // widerspricht, die dieser PR aufstellt: ein deutscher Haushalt bekam
  // Portugiesisch, obwohl eine englische Fassung danebenlag.
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'BR', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  await sync(true);

  const currentYear = new Date().getFullYear();
  const namen = db.prepare(
    "SELECT name FROM holiday_cache WHERE country='BR' AND type='public' AND year=?"
  ).all(currentYear).map((r) => r.name);
  assert.ok(namen.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.ok(namen.includes('Christmas Day'),
    `keine deutsche Fassung, aber eine englische → Englisch, nicht Portugiesisch. Bekam: ${namen.join(', ')}`);
  assert.ok(!namen.includes('Natal'));
});

test('sync: ein geglueckter LEERER Abruf laesst nichts Altes stehen (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT, als zweite Fassung des Fehlers darueber: die
  // HTTP-erfolgreiche Leerantwort nimmt einen eigenen Weg, den der Fix fuer den
  // FEHLER-Fall nicht mit abdeckte. Sie meldete `failed: false`, ohne die alten
  // Zeilen anzufassen - ausgerechnet dieser Bereich behielt seine
  // fremdsprachigen Namen, waehrend der Lauf als vollstaendig verbucht wurde.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'es' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  const vorher = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c;
  assert.ok(vorher > 0, 'ohne Bestand prueft die Zusicherung darunter nichts');

  // Dieselbe Quelle, aber sie kennt jetzt nichts mehr - mit HTTP 200.
  const leer = async () => ({ ok: true, json: async () => [] });
  __setFetchImpl(leer);
  setConfig({ language: 'de' });
  const res = await sync(true);

  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c, 0,
    'ein geglueckter leerer Abruf ist eine Auskunft - der Cache spiegelt sie, statt Altes zu behalten');
  assert.equal(res.incomplete, false, 'eine Leerantwort ist kein Fehlschlag');
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value?.startsWith('DE|'),
    'und darf deshalb den Merker setzen - es steht ja nichts Fremdsprachiges mehr da');
});

test('sync: die Wartemarke bremst keinen NEUEN Bereich (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT, nachdem die Marke die Sprache trug: sie
  // bremste immer noch ein inzwischen anderes LAND aus, dessen Abruf noch nie
  // versucht worden war. Der Speichern-Weg in den Einstellungen schreibt nur
  // die neue Auswahl - der naechste Scheduler-Lauf kaeme mit derselben Sprache
  // und derselben offenen Marke hier an und wartet bis zu einer Stunde auf
  // etwas, das mit dem Fehlschlag nichts zu tun hat.
  setConfig({
    holiday_country: 'ES', holiday_subdivision: 'ES-CT',
    holiday_show_public: '1', holiday_show_school: '0', language: 'en',
  });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Nachlauf auf DE fuer ES/ES-CT scheitert.
  setConfig({ language: 'de' });
  __setFetchImpl(async () => { throw new Error('network down'); });
  await captureConsole(() => sync(true));
  const marke = db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_scope'").get()?.value;
  assert.ok(marke?.startsWith('DE|ES|ES-CT'), `Marke traegt den gescheiterten Bereich, war: ${marke}`);

  // Derselbe Bereich wird gebremst ...
  const gleich = makeApiMock();
  __setFetchImpl(gleich);
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(gleich.calls.length, 0);

  // ... ein anderes LAND bei gleicher Sprache nicht.
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-BY' });
  const anderes = makeApiMock();
  __setFetchImpl(anderes);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein neuer Bereich darf nicht an der Marke des alten haengenbleiben');
  assert.ok(anderes.calls.some((u) => u.includes('countryIsoCode=DE')));
});

test('sync: ein unvollstaendiger Lauf meldet sich nicht als "complete" (#946)', async () => {
  // Genau diese Logzeile hat der Melder von #946 zitiert, um zu zeigen, dass
  // die Synchronisierung durchgelaufen sei ("Holiday sync complete: 35 entries
  // for ES/ES-CT"). Eine Erfolgsmeldung ueber einem halb geholten Bestand
  // haette ihn ein zweites Mal in die Irre gefuehrt - und der Log ist bei einem
  // selbstgehosteten Server oft die einzige Auskunft.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  const gut = await captureConsole(() => sync(true));
  assert.ok(gut.info.some((l) => /complete/i.test(l)), 'ein geglueckter Lauf meldet sich als complete');
  assert.ok(!gut.info.some((l) => /INCOMPLETE/.test(l)));

  setConfig({ language: 'de' });
  __setFetchImpl(async () => { throw new Error('network down'); });
  const schlecht = await captureConsole(() => sync(true));
  assert.ok(!schlecht.info.some((l) => /complete/i.test(l)),
    'ein Lauf mit gescheiterten Abrufen darf sich nicht als complete melden');
  assert.ok(schlecht.warn.some((l) => /INCOMPLETE/.test(l)),
    'er muss stattdessen sagen, dass etwas fehlt - sonst sucht der naechste Melder an der falschen Stelle');
});

test('sync: die Wartemarke bremst nur die Sprache, bei der es schiefging (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Die Marke trug zuerst nur einen Zeitpunkt -
  // und bremste damit auch eine INZWISCHEN ANDERS gewaehlte Sprache aus, obwohl
  // deren Versuch neu ist und noch nie gescheitert war.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Nachlauf auf DE scheitert → Marke fuer DE.
  setConfig({ language: 'de' });
  __setFetchImpl(async () => { throw new Error('network down'); });
  await captureConsole(() => sync(true));
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_scope'").get()?.value?.startsWith('DE|ES|'),
    'die Marke traegt die volle Identitaet des Versuchs: Sprache, Land, Region, Ebenen');

  // Derselbe Wunsch DE wird gebremst ...
  const mockDe = makeApiMock();
  __setFetchImpl(mockDe);
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(mockDe.calls.length, 0);

  // ... eine FRISCH gewaehlte Sprache nicht.
  setConfig({ language: 'es' });
  const mockEs = makeApiMock();
  __setFetchImpl(mockEs);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein neuer Sprachwunsch darf nicht an der Marke der alten haengenbleiben');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_scope'").get()?.value, undefined,
    'ein geglueckter Lauf raeumt die Marke weg');
});

test('sync: eine abgeschaltete Ebene wird beim Wiedereinschalten nachgeholt (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Steht eine Ebene auf aus, holt die Schleife
  // sie nicht - der Merker wurde trotzdem gesetzt. Schaltet der Haushalt sie
  // spaeter wieder an (der Speichern-Weg in den Einstellungen ruft den
  // Sync-Endpunkt NICHT), saehe der Scheduler "unveraendert" und liesse ihre
  // alten, fremdsprachigen Zeilen stehen. Der Merker traegt deshalb auch die
  // aktiven Ebenen.
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '1', language: 'de' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c > 0);

  // Schulferien aus, Sprache wechselt - nur die Feiertage werden geholt.
  setConfig({ holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Wieder an, gleiche Sprache: das ist ein NEUER Scope und muss laufen.
  setConfig({ holiday_show_school: '1' });
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'eine wieder eingeschaltete Ebene muss nachgeholt werden');
  assert.ok(mock.calls.some((u) => u.includes('/SchoolHolidays')));
  assert.equal(db.prepare("SELECT name FROM holiday_cache WHERE type='school' LIMIT 1").get()?.name, 'Summer break',
    'sonst stuenden ihre Namen weiter in der alten Sprache da');
});

test('sync: ein Zurueckwechseln nach einem Teilfehlschlag repariert den Rest (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Nach einem halb geglueckten Wechsel steht
  // der Cache GEMISCHT da. Bliebe der alte Merker stehen, waere ein
  // Zurueckwechseln auf ihn "unveraendert", die 30-Tage-Sperre griffe, und die
  // bereits umgestellten Bereiche behielten ihre neuen Namen fuer einen Monat.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Wechsel auf DE scheitert.
  setConfig({ language: 'de' });
  __setFetchImpl(async () => { throw new Error('network down'); });
  await captureConsole(() => sync(true));
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value, undefined,
    'nach einem Teilfehlschlag darf kein Scope als erledigt gelten');

  // Zurueck auf EN - und das muss laufen, obwohl EN der zuletzt vollstaendige war.
  setConfig({ language: 'en' });
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein Zurueckwechseln nach einem Teilfehlschlag muss reparieren, nicht throtteln');
  assert.ok(mock.calls.length > 0);
});

test('sync: ein Fehlschlag wird wiederholt, ohne dass der Haushalt etwas aendert (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Die Reparatur hing an `languageChanged` -
  // ein gescheiterter 30-Tage-Refresh in derselben Sprache schrieb einen
  // frischen Zeitstempel und wurde danach von der 30-Tage-Sperre erwischt: der
  // fehlgeschlagene Bereich blieb einen weiteren Monat alt.
  //
  // Was ihn heute rettet, ist das LOESCHEN des Merkers beim Fehlschlag: danach
  // gilt jeder Scope als neu, die 30-Tage-Sperre greift nicht mehr, und die
  // Reparaturmarke bremst nur noch die Wiederholrate. Der Test heisst deshalb
  // nach dem, was er zusichert - "ohne dass der Haushalt etwas aendert" -, und
  // nicht nach einer Bedingung im Code: eine Gegenprobe an der Sperrenzeile
  // blieb gruen, weil das Loeschen des Merkers die Arbeit schon getan hatte.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Erneuter Lauf in DERSELBEN Sprache scheitert.
  __setFetchImpl(async () => { throw new Error('network down'); });
  await captureConsole(() => sync(true));
  const marke = db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value;
  assert.ok(marke, 'ein Fehlschlag hinterlaesst eine Reparaturmarke, auch ohne Sprachwechsel');

  // Solange die Marke gilt: keine neuen Abrufe.
  const gebremst = makeApiMock();
  __setFetchImpl(gebremst);
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(gebremst.calls.length, 0);

  // Marke abgelaufen: der Lauf muss durch, obwohl der Zeitstempel frisch ist
  // und sich nichts geaendert hat.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('holiday_retry_after', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(new Date(Date.now() - 1000).toISOString());
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'nach Ablauf der Marke muss der gescheiterte Bereich erneut versucht werden');
  assert.ok(mock.calls.length > 0);
});

test('sync: ein Sprachwechsel holt auch Jahre ausserhalb des Fensters nach (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Das Fenster wandert (currentYear-1 .. +2),
  // der Cache nicht: eine Installation, die 2025 lief, hat Zeilen fuer 2024
  // liegen, und die faellt spaeter heraus. `getForRange()` kennt keine
  // Fenstergrenze und zeigt sie beim Zurueckblaettern weiter - nach einem
  // Sprachwechsel also unbegrenzt lange in der alten Sprache.
  //
  // Sie zu loeschen waere konsistent gewesen, haette aber alte Jahre leer
  // gelassen. Sie werden stattdessen MITGEHOLT: es sind wenige, sie sind
  // abrufbar, und der Aufwand faellt nur bei einem echten Wechsel an.
  const altesJahr = new Date().getFullYear() - 5;
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Eine Zeile aus einem laengst herausgefallenen Jahr, wie sie ein alter
  // Betrieb hinterlaesst.
  seedHoliday({ type: 'public', country: 'DE', start: `${altesJahr}-01-01`, end: `${altesJahr}-01-01`, name: 'Neujahr', year: altesJahr });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM holiday_cache WHERE year = ?').get(altesJahr).c, 1);

  // Sprachwechsel: das alte Jahr muss mit abgefragt werden.
  setConfig({ language: 'en' });
  const mock = makeApiMock();
  __setFetchImpl(mock);
  await sync(true);

  assert.ok(mock.calls.some((u) => u.includes(`validFrom=${altesJahr}-01-01`)),
    `das Jahr ${altesJahr} liegt im Cache und muss beim Wechsel mit abgefragt werden`);
  const alt = db.prepare('SELECT name FROM holiday_cache WHERE year = ?').all(altesJahr).map((r) => r.name);
  assert.ok(!alt.includes('Neujahr'),
    `im Cache stand nach dem Wechsel weiter der deutsche Name: ${alt.join(', ') || '(nichts)'}`);

  // Ohne Wechsel bleibt es beim Fenster - der Zusatzaufwand faellt nur an,
  // wenn sich wirklich etwas geaendert hat.
  const ohneWechsel = makeApiMock();
  __setFetchImpl(ohneWechsel);
  await sync(true);
  assert.ok(!ohneWechsel.calls.some((u) => u.includes(`validFrom=${altesJahr}-01-01`)),
    'ohne Scope-Wechsel wird das Fenster nicht ausgeweitet');
});

test('sync: eine unerwartete Antwortform raeumt den Cache NICHT (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT, als Folgefehler der Aenderung darueber. Seit
  // ein geglueckter LEERER Abruf den Bereich raeumt, entscheidet die Form der
  // Antwort ueber Bestand oder Verlust: ein HTTP 200 mit einem Fehlerobjekt
  // eines vorgeschalteten Proxys oder einer geaenderten Antwortform haette den
  // Cache geloescht UND den Scope als vollstaendig verbucht - die Feiertage
  // waeren 30 Tage lang weg gewesen. Nur ein echtes leeres Array ist eine
  // Auskunft.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'es' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  const vorher = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c;
  assert.ok(vorher > 0, 'ohne Bestand prueft die Zusicherung darunter nichts');

  // HTTP 200, aber kein Array - so sieht ein Proxy-Fehler aus.
  __setFetchImpl(async () => ({ ok: true, json: async () => ({ error: 'upstream unavailable' }) }));
  setConfig({ language: 'de' });
  const res = await captureConsole(() => sync(true));

  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c, vorher,
    'eine unverstandene Antwort darf keinen Bestand loeschen');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value, undefined,
    'und sie darf den Lauf nicht als vollstaendig verbuchen');
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value,
    'stattdessen bleibt eine Reparaturmarke offen');
  assert.ok(res.warn.some((l) => /unexpected response shape/.test(l)),
    'und der Log sagt, was er nicht verstanden hat');
});

test('sync: zwei Laeufe verschraenken sich nicht (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Der Scheduler ruft sync() alle
  // SYNC_INTERVAL_MINUTES, der Knopf "Jetzt synchronisieren" ruft sync(true) -
  // beide ohne Absprache. Ueber die await-Punkte im Jahres-Loop konnten sie
  // sich mischen: der aeltere Lauf ueberschreibt Jahre, die der neuere schon
  // umgestellt hat, und der neuere verbucht am Ende SEINEN Scope als
  // vollstaendig. Vorher war dasselbe Rennen harmlos - es holte hoechstens ein
  // Jahr doppelt; erst der Merker macht daraus einen festgeschriebenen
  // Mischzustand.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  let drin = 0;
  let maxDrin = 0;
  const langsam = async (url) => {
    drin += 1;
    maxDrin = Math.max(maxDrin, drin);
    await new Promise((r) => setTimeout(r, 5));
    drin -= 1;
    return makeApiMock()(url);
  };
  __setFetchImpl(langsam);

  await Promise.all([sync(true), sync(true)]);

  assert.equal(maxDrin, 1,
    `zwei Laeufe waren gleichzeitig im Abruf (${maxDrin}) - sie koennen sich gegenseitig ueberschreiben`);

  // Und das Ergebnis ist einsprachig, nicht gemischt.
  const namen = db.prepare("SELECT DISTINCT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual(namen, ['Weihnachtstag']);
});

test('sync: der wartende Lauf sieht den NEUEN Stand, nicht den alten (#946)', async () => {
  // Der zweite Aufruf bekommt nicht das Ergebnis des ersten gereicht, sondern
  // laeuft selbst - und liest seine Konfiguration erst, wenn er dran ist. Nur
  // so kann ein Sprachwechsel, der WAEHREND eines laufenden Syncs gespeichert
  // wird, ueberhaupt ankommen.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  const ersterLauf = sync(true);
  // Waehrend der erste laeuft, wechselt die Sprache.
  setConfig({ language: 'en' });
  const zweiterLauf = sync(true);
  await Promise.all([ersterLauf, zweiterLauf]);

  const namen = db.prepare("SELECT DISTINCT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual(namen, ['Christmas Day'],
    'der zuletzt gestartete Lauf gibt den Ausschlag, und zwar vollstaendig - nicht halb');
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value?.startsWith('EN|'));
});

// ---- #965: lokal berechnete Laender (US/CA/GB/AU/NZ) ------------------------
// Jedes Datum unten wurde unabhaengig gegen `date -d` (Wochentags-Fakten) und
// gegen amtliche/gut belegte Quellen (GOV.UK, mygov.scot, MBIE, Canada.ca)
// geprueft, nicht nur gegen die eigene Implementierung - sonst bewiese ein
// Test nur, dass Code und Fixture denselben (moeglicherweise falschen)
// Gedankengang teilen.

test('US: 11 Bundesfeiertage, inkl. Beobachtungsregel (Samstag zurueck, Sonntag vor)', () => {
  const names2026 = namesAndDates(2026, 'US');
  assert.equal(names2026.length, 11);
  // 2026: 4. Juli faellt auf einen Samstag -> beobachtet am 3. Juli (rueckwaerts).
  assert.ok(names2026.includes('2026-07-03 Independence Day'));
  assert.ok(!names2026.some((n) => n.includes('07-04')));
  // 19. Juni 2026 ist ein Freitag (Werktag) - keine Verschiebung.
  assert.ok(names2026.includes('2026-06-19 Juneteenth National Independence Day'));
  // n-ter-Wochentag-Feiertage 2026, unabhaengig gegengeprueft:
  assert.ok(names2026.includes('2026-01-19 Martin Luther King, Jr. Day'));   // 3. Montag Januar
  assert.ok(names2026.includes('2026-02-16 Washington\'s Birthday'));         // 3. Montag Februar
  assert.ok(names2026.includes('2026-05-25 Memorial Day'));                  // letzter Montag Mai
  assert.ok(names2026.includes('2026-09-07 Labor Day'));                     // 1. Montag September
  assert.ok(names2026.includes('2026-10-12 Columbus Day'));                  // 2. Montag Oktober
  assert.ok(names2026.includes('2026-11-26 Thanksgiving Day'));              // 4. Donnerstag November
});

test('US: Sonntag verschiebt vorwaerts auf Montag', () => {
  // 2027: 4. Juli ist ein Sonntag -> beobachtet Montag 5. Juli.
  const names2027 = namesAndDates(2027, 'US');
  assert.ok(names2027.includes('2027-07-05 Independence Day'));
  // 19. Juni 2027 ist ein Samstag -> beobachtet Freitag 18. Juni (rueckwaerts).
  assert.ok(names2027.includes('2027-06-18 Juneteenth National Independence Day'));
});

test('US: ein auf das Vorjahr zurueckfallendes Beobachtungsdatum bleibt korrekt (Neujahr 2028)', () => {
  // 1. Januar 2028 ist ein Samstag -> beobachtet Freitag, 31. Dezember 2027 -
  // ein Datum im VORjahr, obwohl es aus der Feiertagsliste fuer 2028 stammt.
  // getForRange() filtert ohnehin nur nach Datum, nicht nach dem year-Feld,
  // daher ist das unschaedlich - aber ohne diesen Test unbemerkt falsch
  // gewesen waere es leicht gewesen.
  const names2028 = namesAndDates(2028, 'US');
  assert.ok(names2028.includes("2027-12-31 New Year's Day"),
    `erwartet 2027-12-31, bekam: ${names2028.filter((n) => n.includes('New Year')).join(', ')}`);
});

test('CA: 10 Feiertage, EN/FR-Kaskade, Victoria Day zwischen dem 18. und 24. Mai', () => {
  const en2026 = namesAndDates(2026, 'CA');
  assert.equal(en2026.length, 10);
  // 2026: der 25. Mai selbst ist ein Montag - Victoria Day bleibt trotzdem der
  // 18. ("Monday PRECEDING May 25", nicht "on or before"), sonst waere das
  // Gesetz identisch mit "letzter Montag im Mai" und Victoria Day faelschlich
  // auf den 25.
  assert.ok(en2026.includes('2026-05-18 Victoria Day'), `bekam: ${en2026.filter((n) => n.includes('Victoria')).join(', ')}`);

  const fr2026 = localHolidayFallback('CA', 'public', 2026, 'FR')
    .map((h) => `${h.startDate} ${h.name}`).sort();
  assert.ok(fr2026.includes('2026-05-18 Fête de la Reine'));
  // Review-Fund zu #965: hier stand ein ||, dessen zweiter Operand (`some` +
  // `includes` auf den Namen) den ersten verschluckte - geprueft war damit nur
  // noch der Name, nicht das Datum. Exakt gebunden prueft die eine Zeile beides.
  assert.ok(fr2026.includes('2026-07-01 Fête du Canada'), `bekam: ${fr2026.filter((n) => n.includes('Canada')).join(', ')}`);
});

test('CA: Victoria Day faellt auf den 24., wenn der selbst ein Montag ist', () => {
  // 2027: der 24. Mai ist ein Montag und liegt noch im erlaubten Bereich
  // (18.-24. inklusive) - Victoria Day faellt hier auf den 24., nicht den 17.
  const names2027 = namesAndDates(2027, 'CA');
  assert.ok(names2027.includes('2027-05-24 Victoria Day'));
});

test('CA: nur Sonntag verschiebt, Samstag bleibt unveraendert', () => {
  // 1. Januar 2028 ist ein Samstag - anders als in den USA (rueckwaerts auf
  // Freitag) bleibt der kanadische Feiertag unveraendert am Samstag stehen,
  // weil Kanadas Regel nur Sonntag->Montag kennt (siehe Code-Kommentar).
  const names2028 = namesAndDates(2028, 'CA');
  assert.ok(names2028.includes("2028-01-01 New Year's Day"));
});

test('CA: Weihnachten und Boxing Day werden unabhaengig verschoben - dokumentierte Kollision moeglich', () => {
  // 2022: 25. Dezember ist ein Sonntag (-> Montag 26.), 26. Dezember ist
  // bereits ein Montag (unveraendert) - beide landen auf demselben Datum.
  // Das ist die im Code-Kommentar dokumentierte, bewusst hingenommene Luecke
  // gegenueber dem UK/NZ-Paarschema, nicht ein uebersehener Fehler.
  const names2022 = namesAndDates(2022, 'CA');
  const dec26 = names2022.filter((n) => n.startsWith('2022-12-26'));
  assert.deepEqual(dec26, ['2022-12-26 Boxing Day', '2022-12-26 Christmas Day']);
});

test('GB (England & Wales): 8 Feiertage; Neujahr verschiebt VORWAERTS auf Montag, anders als die USA', () => {
  const namesEng = namesAndDates(2026, 'GB', 'GB-ENG');
  assert.equal(namesEng.length, 8);
  // 1. Januar 2028 ist ein Samstag: UK "mondayised" verschiebt vorwaerts auf
  // Montag 3. Januar - im Gegensatz zu den USA, die am selben Kalenderdatum
  // rueckwaerts auf den 31. Dezember 2027 verschieben (siehe US-Test oben).
  const names2028 = namesAndDates(2028, 'GB', 'GB-ENG');
  assert.ok(names2028.includes("2028-01-03 New Year's Day"),
    `erwartet Montag 3.1.2028 (vorwaerts), bekam: ${names2028.filter((n) => n.includes('New Year')).join(', ')}`);
});

test('GB (England & Wales): Weihnachten/Boxing Day Paar-Verschiebung, amtlich belegte Jahre', () => {
  // 2026: Weihnachten faellt auf Freitag (Werktag, unveraendert); Boxing Day
  // auf Samstag -> Ersatztag Montag 28.12. (GOV.UK/Presseberichte bestaetigt).
  const names2026 = namesAndDates(2026, 'GB', 'GB-ENG');
  assert.ok(names2026.includes('2026-12-25 Christmas Day'));
  assert.ok(names2026.includes('2026-12-28 Boxing Day'));

  // 2027: Weihnachten Samstag -> Ersatztag Montag 27.; Boxing Day Sonntag ->
  // Ersatztag Dienstag 28. (ebenfalls amtlich bestaetigt, siehe #965-Recherche).
  const names2027 = namesAndDates(2027, 'GB', 'GB-ENG');
  assert.ok(names2027.includes('2027-12-27 Christmas Day'));
  assert.ok(names2027.includes('2027-12-28 Boxing Day'));
});

test('GB (Schottland): 9 Feiertage, kein Ostermontag, eigener Sommertermin, 2. Januar als Paar', () => {
  const namesSct2026 = namesAndDates(2026, 'GB', 'GB-SCT');
  assert.equal(namesSct2026.length, 9);
  assert.ok(!namesSct2026.some((n) => n.includes('Easter Monday')));

  // 2022: 1. Januar Samstag, 2. Januar Sonntag -> Ersatztage Montag 3. und
  // Dienstag 4. Januar (amtlich belegtes Beispiel aus der Recherche).
  // '2nd January' in GOV.UK-Schreibweise (Review-Fund zu #965).
  const namesSct2022 = namesAndDates(2022, 'GB', 'GB-SCT');
  assert.ok(namesSct2022.includes("2022-01-03 New Year's Day"),
    `bekam: ${namesSct2022.filter((n) => n.includes('01-0')).join(', ')}`);
  assert.ok(namesSct2022.includes('2022-01-04 2nd January'));
});

test('GB (Nordirland): 10 Feiertage, St Patrick\'s Day + Battle of the Boyne mit Mondayisation', () => {
  const namesNir2026 = namesAndDates(2026, 'GB', 'GB-NIR');
  assert.equal(namesNir2026.length, 10);
  // 2026: Battle of the Boyne (12. Juli) faellt auf einen Sonntag -> Ersatztag
  // Montag 13. Juli (amtlich bestaetigt); St Patrick's Day faellt 2026 auf
  // einen Dienstag (Werktag) und bleibt unveraendert.
  assert.ok(namesNir2026.includes('2026-07-13 Battle of the Boyne (Orangemen’s Day)'),
    `bekam: ${namesNir2026.filter((n) => n.includes('Boyne')).join(', ')}`);
  assert.ok(namesNir2026.includes("2026-03-17 St Patrick's Day"));
});

test('GB: ohne gewaehlte Subdivision gilt England & Wales', () => {
  assert.deepEqual(namesAndDates(2026, 'GB'), namesAndDates(2026, 'GB', 'GB-ENG'));
});

test('AU: 7 landesweite Feiertage, KEINE Wochenend-Verschiebung', () => {
  // Australien hat kein Bundesgesetz fuer Ersatztage (jeder Bundesstaat regelt
  // das selbst, siehe #965-Recherche) - die Liste zeigt daher immer das echte
  // Kalenderdatum, auch wenn es auf ein Wochenende faellt.
  const names2026 = namesAndDates(2026, 'AU');
  assert.equal(names2026.length, 7);
  assert.ok(names2026.includes('2026-04-25 Anzac Day')); // 2026: ein Samstag, bewusst unverschoben
});

test('NZ: Mondayisation fuer Waitangi/Anzac, Matariki nur innerhalb der amtlichen Tabelle', () => {
  // 2026: Anzac Day (25. April) faellt auf einen Samstag -> mondayised auf
  // Montag 27. April (im #965-Rechercheergebnis direkt bestaetigtes Beispiel).
  const names2026 = namesAndDates(2026, 'NZ');
  assert.ok(names2026.includes('2026-04-27 Anzac Day'), `bekam: ${names2026.filter((n) => n.includes('Anzac')).join(', ')}`);
  // Matariki 2026 laut MBIE: Freitag, 10. Juli (nicht der 9., wie eine grobe
  // Schaetzung nahelegen wuerde - deshalb eine amtliche Tabelle, keine Formel).
  assert.ok(names2026.includes('2026-07-10 Matariki'));

  // Jenseits der veroeffentlichten Tabelle (bis 2052) gibt es keinen Matariki-
  // Eintrag - lieber eine Luecke als ein geratenes Datum.
  const names2053 = namesAndDates(2053, 'NZ');
  assert.ok(!names2053.some((n) => n.includes('Matariki')));
});

test('NZ: Neujahr/2.-Januar- und Weihnachten/Boxing-Day-Paare wie in Schottland', () => {
  // 2028: gleiches Wochentagsmuster wie das Schottland-Beispiel oben (1.
  // Januar Samstag) - dieselbe Formel muss dasselbe Ergebnis liefern.
  const names2028 = namesAndDates(2028, 'NZ');
  assert.ok(names2028.includes("2028-01-03 New Year's Day"));
  assert.ok(names2028.includes('2028-01-04 Day after New Year’s Day'));

  // 2021: Weihnachten Samstag, Boxing Day Sonntag -> Montag 27./Dienstag 28.
  // (dasselbe amtlich belegte Beispiel wie fuer UK oben, hier fuer NZ).
  const names2021 = namesAndDates(2021, 'NZ');
  assert.ok(names2021.includes('2021-12-27 Christmas Day'));
  assert.ok(names2021.includes('2021-12-28 Boxing Day'));
});

test("GB (Schottland): St Andrew's Day ist mondayised (Act 2007 s.1(2), Review-Fund zu #965)", () => {
  // GOV.UK (bank-holidays.json) fuehrt 2019-12-02, 2024-12-02 und 2025-12-01
  // als Ersatztage - der 30.11. fiel in diesen Jahren auf Sa/Sa/So. Die erste
  // Fassung dieses PRs liess den Tag unverschoben stehen, und 2025 lag im
  // Sync-Fenster: ein schottischer Haushalt sah das falsche Datum. Der
  // naechste Wochenend-Fall nach 2025 ist 2030 (Sa -> Mo 2.12.).
  for (const [year, expected] of [
    [2019, "2019-12-02 St Andrew's Day"],
    [2024, "2024-12-02 St Andrew's Day"],
    [2025, "2025-12-01 St Andrew's Day"],
    [2026, "2026-11-30 St Andrew's Day"], // Montag - unverschoben
    [2030, "2030-12-02 St Andrew's Day"],
  ]) {
    const names = namesAndDates(year, 'GB', 'GB-SCT');
    assert.ok(names.includes(expected),
      `${year}: erwartet "${expected}", bekam: ${names.filter((n) => n.includes('Andrew')).join(', ') || '(nichts)'}`);
  }
});

// ---- #965 Review: vollstaendige Jahres-Tabellen 2026 + 2027 -------------------
// Der Befund: die Fixtures oben pruefen Zaehler und handverlesene Einzeldaten,
// und sechs Ein-Token-Mutationen der Regeltabelle blieben trotzdem gruen (z. B.
// Schottlands Sommertermin auf "letzter Montag" gedreht - genau die Verwechslung,
// vor der der Code-Kommentar warnt). Diese Tabellen pinnen deshalb JEDES Datum
// beider Jahre, und zwar aus den PRIMAERQUELLEN abgetippt, nicht aus der Engine
// abgelesen - sonst bewiese der Test nur, dass Code und Fixture denselben
// (moeglicherweise falschen) Gedankengang teilen:
//   US: OPM "Federal Holidays" (opm.gov), Tabellen 2026/2027.
//   CA: canada.ca (CRA) 2026; 2027 nach Holidays Act/Bills of Exchange Act
//       (nur So->Mo verschiebt; Sa bleibt - die im Code dokumentierte,
//       bewusste Abweichung von der UK-Paarlogik).
//   GB: gov.uk/bank-holidays.json (alle drei Nationen, 2026 + 2027).
//   AU: landesweite Feiertage auf ihrem echten Kalenderdatum - bewusst ohne
//       Ersatztage (kein Bundesgesetz; siehe AU-Regelsatz).
//   NZ: employment.govt.nz (MBIE), Tabellen 2026/2027 inkl. Matariki.
//   BR: feste gesetzliche Daten + Karfreitag.
// Jede Wochentagsbehauptung wurde zusaetzlich unabhaengig per Datumsarithmetik
// gegengeprueft (jeder "Montag"-Feiertag ist wirklich ein Montag usw.).
//
// BEWUSST NICHT in der Schottland-Tabelle 2026: der per Koeniglicher
// Proklamation geschaffene, einmalige "World Cup bank holiday" am Mo 15.06.2026
// (gov.uk fuehrt ihn). Einmalig proklamierte Feiertage kann keine statische
// Regeltabelle liefern - dokumentierte Grenze, siehe docs/SPEC.md; der
// ICS-Weg ist dafuer die Antwort.

test('US: vollstaendige Datumstabelle 2026 + 2027 (OPM)', () => {
  assert.deepEqual(namesAndDates(2026, 'US'), [
    "2026-01-01 New Year's Day",
    '2026-01-19 Martin Luther King, Jr. Day',
    "2026-02-16 Washington's Birthday",
    '2026-05-25 Memorial Day',
    '2026-06-19 Juneteenth National Independence Day',
    '2026-07-03 Independence Day', // 4.7. ist Samstag -> Freitag davor
    '2026-09-07 Labor Day',
    '2026-10-12 Columbus Day',
    '2026-11-11 Veterans Day',
    '2026-11-26 Thanksgiving Day',
    '2026-12-25 Christmas Day',
  ]);
  assert.deepEqual(namesAndDates(2027, 'US'), [
    "2027-01-01 New Year's Day",
    '2027-01-18 Martin Luther King, Jr. Day',
    "2027-02-15 Washington's Birthday",
    '2027-05-31 Memorial Day',
    '2027-06-18 Juneteenth National Independence Day', // 19.6. Samstag -> Freitag
    '2027-07-05 Independence Day',                     // 4.7. Sonntag -> Montag
    '2027-09-06 Labor Day',
    '2027-10-11 Columbus Day',
    '2027-11-11 Veterans Day',
    '2027-11-25 Thanksgiving Day',
    '2027-12-24 Christmas Day',                        // 25.12. Samstag -> Freitag
  ]);
});

test('CA: vollstaendige Datumstabelle 2026 + 2027 (canada.ca / Holidays Act)', () => {
  assert.deepEqual(namesAndDates(2026, 'CA'), [
    "2026-01-01 New Year's Day",
    '2026-04-03 Good Friday',
    '2026-05-18 Victoria Day', // Montag VOR dem 25.5., obwohl der 25. selbst ein Montag ist
    '2026-07-01 Canada Day',
    '2026-09-07 Labour Day',
    '2026-09-30 National Day for Truth and Reconciliation',
    '2026-10-12 Thanksgiving',
    '2026-11-11 Remembrance Day',
    '2026-12-25 Christmas Day',
    '2026-12-26 Boxing Day', // Samstag - bleibt (nur So->Mo ist belegt)
  ]);
  assert.deepEqual(namesAndDates(2027, 'CA'), [
    "2027-01-01 New Year's Day",
    '2027-03-26 Good Friday',
    '2027-05-24 Victoria Day',
    '2027-07-01 Canada Day',
    '2027-09-06 Labour Day',
    '2027-09-30 National Day for Truth and Reconciliation',
    '2027-10-11 Thanksgiving',
    '2027-11-11 Remembrance Day',
    '2027-12-25 Christmas Day', // Samstag - bleibt bewusst unverschoben
    '2027-12-27 Boxing Day',    // Sonntag -> Montag
  ]);
});

test('GB (England & Wales): vollstaendige Datumstabelle 2026 + 2027 (gov.uk)', () => {
  assert.deepEqual(namesAndDates(2026, 'GB', 'GB-ENG'), [
    "2026-01-01 New Year's Day",
    '2026-04-03 Good Friday',
    '2026-04-06 Easter Monday',
    '2026-05-04 Early May Bank Holiday',
    '2026-05-25 Spring Bank Holiday',
    '2026-08-31 Summer Bank Holiday', // LETZTER Montag im August
    '2026-12-25 Christmas Day',
    '2026-12-28 Boxing Day', // 26.12. Samstag -> Ersatztag Montag
  ]);
  assert.deepEqual(namesAndDates(2027, 'GB', 'GB-ENG'), [
    "2027-01-01 New Year's Day",
    '2027-03-26 Good Friday',
    '2027-03-29 Easter Monday',
    '2027-05-03 Early May Bank Holiday',
    '2027-05-31 Spring Bank Holiday',
    '2027-08-30 Summer Bank Holiday',
    '2027-12-27 Christmas Day', // 25.12. Samstag -> Montag
    '2027-12-28 Boxing Day',    // 26.12. Sonntag -> Dienstag
  ]);
});

test('GB (Schottland): vollstaendige Datumstabelle 2026 + 2027 (gov.uk)', () => {
  assert.deepEqual(namesAndDates(2026, 'GB', 'GB-SCT'), [
    "2026-01-01 New Year's Day",
    '2026-01-02 2nd January',
    '2026-04-03 Good Friday',
    '2026-05-04 Early May Bank Holiday',
    '2026-05-25 Spring Bank Holiday',
    // Hier fehlt bewusst der proklamierte World Cup bank holiday (15.06.2026),
    // siehe Kommentar ueber diesem Block.
    '2026-08-03 Summer Bank Holiday', // ERSTER Montag im August, anders als England/Wales
    "2026-11-30 St Andrew's Day",     // Montag - unverschoben
    '2026-12-25 Christmas Day',
    '2026-12-28 Boxing Day',
  ]);
  assert.deepEqual(namesAndDates(2027, 'GB', 'GB-SCT'), [
    "2027-01-01 New Year's Day",
    '2027-01-04 2nd January', // 2.1. Samstag -> Ersatztag Montag
    '2027-03-26 Good Friday',
    '2027-05-03 Early May Bank Holiday',
    '2027-05-31 Spring Bank Holiday',
    '2027-08-02 Summer Bank Holiday',
    "2027-11-30 St Andrew's Day",
    '2027-12-27 Christmas Day',
    '2027-12-28 Boxing Day',
  ]);
});

test('GB (Nordirland): vollstaendige Datumstabelle 2026 + 2027 (gov.uk)', () => {
  assert.deepEqual(namesAndDates(2026, 'GB', 'GB-NIR'), [
    "2026-01-01 New Year's Day",
    "2026-03-17 St Patrick's Day",
    '2026-04-03 Good Friday',
    '2026-04-06 Easter Monday',
    '2026-05-04 Early May Bank Holiday',
    '2026-05-25 Spring Bank Holiday',
    '2026-07-13 Battle of the Boyne (Orangemen’s Day)', // 12.7. Sonntag -> Montag
    '2026-08-31 Summer Bank Holiday',
    '2026-12-25 Christmas Day',
    '2026-12-28 Boxing Day',
  ]);
  assert.deepEqual(namesAndDates(2027, 'GB', 'GB-NIR'), [
    "2027-01-01 New Year's Day",
    "2027-03-17 St Patrick's Day",
    '2027-03-26 Good Friday',
    '2027-03-29 Easter Monday',
    '2027-05-03 Early May Bank Holiday',
    '2027-05-31 Spring Bank Holiday',
    '2027-07-12 Battle of the Boyne (Orangemen’s Day)', // Montag - unverschoben
    '2027-08-30 Summer Bank Holiday',
    '2027-12-27 Christmas Day',
    '2027-12-28 Boxing Day',
  ]);
});

test('AU: vollstaendige Datumstabelle 2026 + 2027 (echte Kalenderdaten, keine Ersatztage)', () => {
  assert.deepEqual(namesAndDates(2026, 'AU'), [
    "2026-01-01 New Year's Day",
    '2026-01-26 Australia Day',
    '2026-04-03 Good Friday',
    '2026-04-06 Easter Monday',
    '2026-04-25 Anzac Day', // Samstag - bewusst unverschoben
    '2026-12-25 Christmas Day',
    '2026-12-26 Boxing Day',
  ]);
  assert.deepEqual(namesAndDates(2027, 'AU'), [
    "2027-01-01 New Year's Day",
    '2027-01-26 Australia Day',
    '2027-03-26 Good Friday',
    '2027-03-29 Easter Monday',
    '2027-04-25 Anzac Day',      // Sonntag - bewusst unverschoben
    '2027-12-25 Christmas Day',  // Samstag - bewusst unverschoben
    '2027-12-26 Boxing Day',     // Sonntag - bewusst unverschoben
  ]);
});

test('NZ: vollstaendige Datumstabelle 2026 + 2027 (employment.govt.nz)', () => {
  assert.deepEqual(namesAndDates(2026, 'NZ'), [
    "2026-01-01 New Year's Day",
    '2026-01-02 Day after New Year’s Day',
    '2026-02-06 Waitangi Day',
    '2026-04-03 Good Friday',
    '2026-04-06 Easter Monday',
    '2026-04-27 Anzac Day', // 25.4. Samstag -> Montag (Mondayisation seit 2013)
    "2026-06-01 King's Birthday",
    '2026-07-10 Matariki',
    '2026-10-26 Labour Day', // 4. Montag im Oktober
    '2026-12-25 Christmas Day',
    '2026-12-28 Boxing Day', // 26.12. Samstag -> Montag
  ]);
  assert.deepEqual(namesAndDates(2027, 'NZ'), [
    "2027-01-01 New Year's Day",
    '2027-01-04 Day after New Year’s Day', // 2.1. Samstag -> Montag
    '2027-02-08 Waitangi Day',             // 6.2. Samstag -> Montag
    '2027-03-26 Good Friday',
    '2027-03-29 Easter Monday',
    '2027-04-26 Anzac Day',                // 25.4. Sonntag -> Montag
    "2027-06-07 King's Birthday",
    '2027-06-25 Matariki',
    '2027-10-25 Labour Day',
    '2027-12-27 Christmas Day',            // 25.12. Samstag -> Montag
    '2027-12-28 Boxing Day',               // 26.12. Sonntag -> Dienstag
  ]);
});

test('BR: vollstaendige Datumstabelle 2026 + 2027 (feste gesetzliche Daten + Karfreitag)', () => {
  assert.deepEqual(namesAndDates(2026, 'BR'), [
    '2026-01-01 Universal Brotherhood Day',
    '2026-04-03 Good Friday',
    '2026-04-21 Tiradentes Day',
    '2026-05-01 Labour Day',
    '2026-09-07 Independence Day',
    '2026-10-12 Our Lady of Aparecida',
    "2026-11-02 All Souls' Day",
    '2026-11-15 Republic Proclamation Day',
    '2026-11-20 National Zumbi and Black Consciousness Day',
    '2026-12-25 Christmas Day',
  ]);
  assert.deepEqual(namesAndDates(2027, 'BR'), [
    '2027-01-01 Universal Brotherhood Day',
    '2027-03-26 Good Friday',
    '2027-04-21 Tiradentes Day',
    '2027-05-01 Labour Day',
    '2027-09-07 Independence Day',
    '2027-10-12 Our Lady of Aparecida',
    "2027-11-02 All Souls' Day",
    '2027-11-15 Republic Proclamation Day',
    '2027-11-20 National Zumbi and Black Consciousness Day',
    '2027-12-25 Christmas Day',
  ]);
});

test('sync: US public holidays cache locally - ohne einen einzigen /PublicHolidays-Abruf (#965 Review)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'US', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * 11);
  // Review-Fund zu #965: der Live-Abruf lieferte fuer die lokalen Laender im
  // Voraus bekannt 200 [] und loeste nur den Fallback aus - er ist jetzt
  // kurzgeschlossen. Vier gesparte Requests pro Lauf, und der Offline-Fall
  // funktioniert per Konstruktion (eigener Test weiter unten).
  assert.deepEqual(mock.calls.filter((url) => url.includes('/PublicHolidays')), [],
    'ein lokal berechnetes Land darf /PublicHolidays gar nicht erst fragen');
  // Nur EN-Namen fuer die USA - eine deutsche Datensprache bekommt trotzdem
  // Englisch, dokumentiert als bewusste Einschraenkung (siehe Code-Kommentar).
  const currentYear = new Date().getFullYear();
  const namen = db.prepare(
    "SELECT name FROM holiday_cache WHERE country='US' AND type='public' AND year=?",
  ).all(currentYear).map((r) => r.name);
  assert.ok(namen.includes('Christmas Day'));
});

test('sync: GB with a chosen subdivision caches that nation\'s own list', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'GB', holiday_subdivision: 'GB-SCT', holiday_show_public: '1', holiday_show_school: '0' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * 9); // Schottland: 9 statt 8 (England/Wales)
  const currentYear = new Date().getFullYear();
  const namen = db.prepare(
    "SELECT name FROM holiday_cache WHERE country='GB' AND type='public' AND year=?",
  ).all(currentYear).map((r) => r.name);
  assert.ok(namen.includes("St Andrew's Day"));
  assert.ok(!namen.includes('Easter Monday'));
});

test('sync: school holidays for a #965 country store nothing and report incomplete: false', async () => {
  // Der Schulferien-Schalter darf fuer diese Laender technisch eingeschaltet
  // bleiben (kein Server-seitiges Verbot noetig) - es gibt nur nichts zu
  // synchronisieren, und das ist eine Auskunft, kein Fehlschlag.
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'US', holiday_show_public: '0', holiday_show_school: '1' });

  const res = await sync(true);

  assert.equal(res.incomplete, false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='US' AND type='school'").get().c, 0);
});

// ---- getCountries / getSubdivisions -----------------------------------------

test('getCountries: prefers EN names and sorts alphabetically', async () => {
  __setFetchImpl(makeApiMock());
  const list = await getCountries();
  // Neben den zwei API-Laendern erscheinen die sechs lokal berechneten
  // Laender aus #965 - keins davon liefert der Mock, also gewinnt hier
  // niemand gegen die API, es wird nur ergaenzt.
  assert.deepEqual(list, [
    { isoCode: 'AU', name: 'Australia', schoolHolidays: false },
    { isoCode: 'BR', name: 'Brazil', schoolHolidays: false },
    { isoCode: 'CA', name: 'Canada', schoolHolidays: false },
    { isoCode: 'FR', name: 'France' },
    { isoCode: 'DE', name: 'Germany' },
    { isoCode: 'NZ', name: 'New Zealand', schoolHolidays: false },
    { isoCode: 'GB', name: 'United Kingdom', schoolHolidays: false },
    { isoCode: 'US', name: 'United States', schoolHolidays: false },
  ]);
});

test('getCountries: OpenHolidays nicht erreichbar -> die lokalen Laender bleiben waehlbar (#965 Review)', async () => {
  // Vorher warf getCountries den Fetch-Fehler durch, die Route machte daraus
  // ein 502 und das Frontend fiel auf eine leere Liste zurueck - ausgerechnet
  // die Laender, die gar kein Netz brauchen, waren dann nicht mehr waehlbar.
  __setFetchImpl(async () => { throw new Error('network down'); });
  let list;
  const lines = await captureConsole(async () => { list = await getCountries(); });
  assert.deepEqual(list, [
    { isoCode: 'AU', name: 'Australia', schoolHolidays: false },
    { isoCode: 'BR', name: 'Brazil', schoolHolidays: false },
    { isoCode: 'CA', name: 'Canada', schoolHolidays: false },
    { isoCode: 'NZ', name: 'New Zealand', schoolHolidays: false },
    { isoCode: 'GB', name: 'United Kingdom', schoolHolidays: false },
    { isoCode: 'US', name: 'United States', schoolHolidays: false },
  ]);
  assert.ok(lines.warn.some((l) => /Countries/.test(l)),
    'der Ausfall gehoert ins Log - sonst sieht der Betreiber nie, warum nur sechs Laender da sind');
});

test('sync: ein lokal berechnetes Land synchronisiert auch komplett offline (#965 Review)', async () => {
  // Die Gegenprobe zum Kurzschluss: selbst wenn JEDER Fetch scheitert, laeuft
  // ein Nur-Feiertage-Sync fuer ein lokales Land vollstaendig durch - die
  // Daten sind reine Datumsarithmetik, kein Netz noetig. Vorher haette der
  // sinnlose /PublicHolidays-Abruf den Lauf zwar auch ueber den Fallback
  // gerettet, ihn aber als Fehlschlag verbucht (failed -> Reparaturmarke).
  __setFetchImpl(async () => { throw new Error('network down'); });
  setConfig({ holiday_country: 'GB', holiday_subdivision: 'GB-SCT', holiday_show_public: '1', holiday_show_school: '0' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * 9);
  assert.equal(res.incomplete, false, 'offline ist fuer ein lokales Land kein Fehlschlag');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value, undefined,
    'und darf deshalb auch keine Reparaturmarke hinterlassen');
});

test('getCountries: an API-listed local country is not duplicated - the API entry wins', async () => {
  // Simuliert die echte OpenHolidays-API, die Brasilien tatsaechlich fuehrt
  // (siehe #965-Recherche): unsere lokale BR-Ergaenzung darf dann nicht als
  // zweiter Eintrag erscheinen.
  __setFetchImpl(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/Countries') {
      return okJson([{ isoCode: 'BR', name: [{ language: 'EN', text: 'Brazil (API)' }] }]);
    }
    return okJson([]);
  });
  const list = await getCountries();
  const brEntries = list.filter((c) => c.isoCode === 'BR');
  assert.equal(brEntries.length, 1);
  assert.equal(brEntries[0].name, 'Brazil (API)');
  assert.equal(brEntries[0].schoolHolidays, undefined, 'der API-Eintrag traegt kein schoolHolidays-Flag');
});

test('getSubdivisions: GB is answered locally, without an API call (#965)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const list = await getSubdivisions('GB');
  assert.deepEqual(list, [
    { isoCode: 'GB-ENG', name: 'England and Wales' },
    { isoCode: 'GB-NIR', name: 'Northern Ireland' },
    { isoCode: 'GB-SCT', name: 'Scotland' },
  ]);
  assert.equal(mock.calls.length, 0, 'GB ist kein echtes OpenHolidays-Land - kein Netzwerkaufruf noetig');
});

test('getGroups: GB has none, answered locally without an API call', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  assert.deepEqual(await getGroups('GB', 'GB-ENG'), []);
  assert.equal(mock.calls.length, 0);
});

test('getSubdivisions: maps code/name, falls back to shortName, sorts', async () => {
  __setFetchImpl(makeApiMock());
  const list = await getSubdivisions('DE');
  assert.deepEqual(list, [
    { isoCode: 'DE-BY', name: 'Bavaria' },
    { isoCode: 'DE-BW', name: 'BW' },
  ]);
});

test('teardown: restore real database', () => {
  _resetTestDatabase();
});
