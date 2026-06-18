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
import Database from 'better-sqlite3';
import { MIGRATIONS, _setTestDatabase, _resetTestDatabase } from '../server/db.js';
import { sync, getForRange, getCountries, getSubdivisions, __setFetchImpl } from '../server/services/holidays.js';

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

function seedHoliday({ type, country = 'DE', subdivision = null, start, end, name = 'Test', year }) {
  db.prepare(`INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(type, country, subdivision, start, end, name, year ?? Number(start.slice(0, 4)));
}

const okJson = (data) => ({ ok: true, json: async () => data });

// fetch-Mock, das je nach OpenHolidays-Endpoint deterministische Daten liefert.
function makeApiMock() {
  const calls = [];
  const fn = async (url) => {
    const s = String(url);
    calls.push(s);
    const path = new URL(s).pathname;
    const country = new URL(s).searchParams.get('countryIsoCode');
    if (path === '/PublicHolidays') {
      if (country === 'BR') return okJson([]);
      return okJson([{ startDate: '2026-01-01', endDate: '2026-01-01',
        name: [{ language: 'DE', text: 'Neujahr' }, { language: 'EN', text: "New Year's Day" }] }]);
    }
    if (path === '/SchoolHolidays') {
      return okJson([{ startDate: '2026-07-20', endDate: '2026-08-30',
        name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer break' }] }]);
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

test('sync: public-only fetches PublicHolidays per year, caches them, sets last_sync', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN);
  assert.ok(mock.calls.every((u) => u.includes('/PublicHolidays')));
  assert.ok(!mock.calls.some((u) => u.includes('/SchoolHolidays')));

  const pub = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(pub, SYNC_YEAR_SPAN);
  // German locale name is resolved and stored
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

test('sync: both layers enabled caches public and school entries', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '1' });
  const res = await sync(true);
  assert.equal(res.synced, SYNC_YEAR_SPAN * 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c, SYNC_YEAR_SPAN);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c, SYNC_YEAR_SPAN);
});

test('sync: Brazil public holidays use PT and local fallback when OpenHolidays has no rows', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'BR', holiday_show_public: '1', holiday_show_school: '0' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * BRAZIL_PUBLIC_HOLIDAYS_PER_YEAR);
  assert.ok(mock.calls.every((url) => url.includes('countryIsoCode=BR')));
  assert.ok(mock.calls.every((url) => url.includes('languageIsoCode=PT')));

  const currentYear = new Date().getFullYear();
  const names = db.prepare(
    "SELECT name FROM holiday_cache WHERE country='BR' AND type='public' AND year=? ORDER BY start_date"
  ).all(currentYear).map((row) => row.name);
  assert.ok(names.includes('Tiradentes'));
  assert.ok(names.includes('Dia Nacional de Zumbi e da Consciência Negra'));
  assert.ok(names.includes('Natal'));
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

// ---- getCountries / getSubdivisions -----------------------------------------

test('getCountries: prefers EN names and sorts alphabetically', async () => {
  __setFetchImpl(makeApiMock());
  const list = await getCountries();
  assert.deepEqual(list, [
    { isoCode: 'FR', name: 'France' },
    { isoCode: 'DE', name: 'Germany' },
  ]);
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
