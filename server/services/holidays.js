/**
 * Modul: Feiertage & Schulferien (Holidays)
 * Zweck: Fetch von der OpenHolidays API, Caching in holiday_cache-Tabelle,
 *        periodischer Sync. Kein API-Key erforderlich.
 * Quelle: https://openholidaysapi.org (open source, kostenlos)
 * Abhängigkeiten: node-fetch, server/db.js
 */

import nodeFetch from 'node-fetch';
import { createLogger } from '../logger.js';
import * as db from '../db.js';

const log = createLogger('Holidays');

const BASE_URL          = 'https://openholidaysapi.org';
const FETCH_TIMEOUT_MS  = 15_000;
const SYNC_YEARS_BACK   = 1;
const SYNC_YEARS_AHEAD  = 2;

// Injizierbare fetch-Implementierung (Default: node-fetch). Nur Tests
// überschreiben dies via __setFetchImpl, um die OpenHolidays-API zu mocken.
let fetchImpl = nodeFetch;
function __setFetchImpl(fn) { fetchImpl = fn ?? nodeFetch; }

// --------------------------------------------------------
// API-Abfragen
// --------------------------------------------------------

async function apiFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Alle verfügbaren Länder abrufen.
 * @returns {Promise<Array<{isoCode: string, name: string}>>}
 */
async function getCountries() {
  const raw = await apiFetch('/Countries');
  return (raw ?? []).map((c) => ({
    isoCode: c.isoCode,
    name: resolveName(c.name),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Unterteilungen (Bundesländer etc.) für ein Land abrufen.
 * @param {string} countryIsoCode z.B. 'DE'
 * @returns {Promise<Array<{isoCode: string, name: string}>>}
 */
async function getSubdivisions(countryIsoCode) {
  const raw = await apiFetch(`/Subdivisions?countryIsoCode=${encodeURIComponent(countryIsoCode)}`);
  return (raw ?? []).map((s) => ({
    isoCode: s.isoCode ?? s.code,
    name: resolveName(s.name) || s.shortName || s.isoCode || s.code,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gibt den Anzeigenamen aus dem name-Array zurück (bevorzugt EN, sonst erstes).
 * @param {Array<{language, text}>} nameArr
 * @param {string} [preferLang='EN']
 */
function resolveName(nameArr, preferLang = 'EN') {
  if (!Array.isArray(nameArr) || nameArr.length === 0) return '';
  const preferred = nameArr.find((n) => n.language === preferLang);
  return (preferred ?? nameArr[0]).text ?? '';
}

// --------------------------------------------------------
// Sync-Logik
// --------------------------------------------------------

async function syncYearAndType(country, subdivision, year, type, langCode) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const endpoint = type === 'public' ? 'PublicHolidays' : 'SchoolHolidays';

  let params = `countryIsoCode=${encodeURIComponent(country)}&languageIsoCode=${encodeURIComponent(langCode)}&validFrom=${from}&validTo=${to}`;
  if (subdivision) params += `&subdivisionCode=${encodeURIComponent(subdivision)}`;

  let holidays;
  try {
    holidays = await apiFetch(`/${endpoint}?${params}`);
  } catch (err) {
    log.warn(`Fetch ${endpoint} ${country}/${subdivision ?? '-'}/${year}: ${err.message}`);
    return 0;
  }

  if (!Array.isArray(holidays) || holidays.length === 0) return 0;

  const insert = db.get().prepare(`
    INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.get().transaction((rows) => {
    for (const h of rows) {
      insert.run(type, country, subdivision ?? null, h.startDate, h.endDate, resolveName(h.name, langCode.toUpperCase()), year);
    }
  });

  // Alte Einträge für diesen Scope löschen, dann neu einfügen
  db.get().prepare(
    'DELETE FROM holiday_cache WHERE type = ? AND country = ? AND (subdivision IS ? OR subdivision = ?) AND year = ?'
  ).run(type, country, subdivision ?? null, subdivision ?? '', year);

  insertAll(holidays);
  return holidays.length;
}

/**
 * Sync Feiertage und/oder Schulferien für das konfigurierte Land/Region.
 * Wird vom Auto-Scheduler und manuell aus den Settings aufgerufen.
 */
async function sync() {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';

  if (!country) {
    log.info('No holiday country configured – skipping sync.');
    return { synced: 0 };
  }

  if (!showPublic && !showSchool) {
    log.info('Both holiday layers disabled – skipping sync.');
    return { synced: 0 };
  }

  // Sprache aus Land ableiten (Fallback EN)
  const langMap = {
    DE: 'DE', AT: 'DE', CH: 'DE', FR: 'FR', ES: 'ES', IT: 'IT',
    NL: 'NL', PL: 'PL', PT: 'PT', RU: 'RU', TR: 'TR', CZ: 'CS',
    SE: 'SV', NO: 'NO', DK: 'DA', FI: 'FI', HU: 'HU', RO: 'RO',
    GR: 'EL', SK: 'SK', HR: 'HR', BG: 'BG', RS: 'SR', SI: 'SL',
  };
  const langCode = langMap[country] ?? 'EN';

  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - SYNC_YEARS_BACK; y <= currentYear + SYNC_YEARS_AHEAD; y++) {
    years.push(y);
  }

  let total = 0;
  for (const year of years) {
    if (showPublic) total += await syncYearAndType(country, subdivision, year, 'public', langCode);
    if (showSchool) total += await syncYearAndType(country, subdivision, year, 'school', langCode);
  }

  const now = new Date().toISOString();
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES ('holiday_last_sync', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(now);

  log.info(`Holiday sync complete: ${total} entries for ${country}${subdivision ? '/' + subdivision : ''}`);
  return { synced: total, lastSync: now };
}

/**
 * Feiertage/Ferien für einen Datumsbereich aus dem Cache lesen.
 * @param {string} from YYYY-MM-DD
 * @param {string} to   YYYY-MM-DD
 * @returns {Array<{id, type, start_date, end_date, name}>}
 */
function getForRange(from, to) {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';
  const pubColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_public_color'").get()?.value ?? '#FF3B30';
  const schColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_school_color'").get()?.value ?? '#34C759';

  if (!country || (!showPublic && !showSchool)) return [];

  const types = [];
  if (showPublic) types.push('public');
  if (showSchool) types.push('school');

  const placeholders = types.map(() => '?').join(', ');

  const rows = db.get().prepare(`
    SELECT id, type, start_date, end_date, name
    FROM holiday_cache
    WHERE country = ?
      AND (subdivision IS NULL OR subdivision = ? OR subdivision = '')
      AND type IN (${placeholders})
      AND start_date <= ?
      AND end_date   >= ?
    ORDER BY start_date ASC
  `).all(country, subdivision ?? '', ...types, to, from);

  return rows.map((r) => ({
    ...r,
    color: r.type === 'public' ? pubColor : schColor,
  }));
}

export { sync, getCountries, getSubdivisions, getForRange, __setFetchImpl };
