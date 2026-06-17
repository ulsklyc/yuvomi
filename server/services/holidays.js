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

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

function localizedBrazilHolidayName(key, langCode) {
  const names = {
    universalBrotherhood: { PT: 'Confraternização Universal', EN: 'Universal Brotherhood Day' },
    goodFriday:           { PT: 'Sexta-feira Santa', EN: 'Good Friday' },
    tiradentes:           { PT: 'Tiradentes', EN: 'Tiradentes Day' },
    labourDay:            { PT: 'Dia do Trabalho', EN: 'Labour Day' },
    independence:         { PT: 'Independência do Brasil', EN: 'Independence Day' },
    aparecida:            { PT: 'Nossa Senhora Aparecida', EN: 'Our Lady of Aparecida' },
    allSouls:             { PT: 'Finados', EN: "All Souls' Day" },
    republic:             { PT: 'Proclamação da República', EN: 'Republic Proclamation Day' },
    blackConsciousness:   { PT: 'Dia Nacional de Zumbi e da Consciência Negra', EN: 'National Zumbi and Black Consciousness Day' },
    christmas:            { PT: 'Natal', EN: 'Christmas Day' },
  };
  const lang = String(langCode || '').toUpperCase();
  return names[key]?.[lang] ?? names[key]?.PT ?? key;
}

function brazilPublicHolidays(year, langCode) {
  const fixed = [
    ['universalBrotherhood', 1, 1],
    ['tiradentes', 4, 21],
    ['labourDay', 5, 1],
    ['independence', 9, 7],
    ['aparecida', 10, 12],
    ['allSouls', 11, 2],
    ['republic', 11, 15],
    ['blackConsciousness', 11, 20],
    ['christmas', 12, 25],
  ].map(([key, month, day]) => {
    const date = formatIsoDate(utcDate(year, month, day));
    return { startDate: date, endDate: date, name: localizedBrazilHolidayName(key, langCode) };
  });

  const goodFriday = formatIsoDate(addDays(easterSunday(year), -2));
  return [
    fixed[0],
    { startDate: goodFriday, endDate: goodFriday, name: localizedBrazilHolidayName('goodFriday', langCode) },
    ...fixed.slice(1),
  ];
}

function localHolidayFallback(country, type, year, langCode) {
  if (country === 'BR' && type === 'public') return brazilPublicHolidays(year, langCode);
  return [];
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
    holidays = localHolidayFallback(country, type, year, langCode);
  }

  if (!Array.isArray(holidays) || holidays.length === 0) {
    holidays = localHolidayFallback(country, type, year, langCode);
  }
  if (!Array.isArray(holidays) || holidays.length === 0) return 0;

  const insert = db.get().prepare(`
    INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.get().transaction((rows) => {
    for (const h of rows) {
      const name = typeof h.name === 'string'
        ? h.name
        : resolveName(h.name, langCode.toUpperCase());
      insert.run(type, country, subdivision ?? null, h.startDate, h.endDate, name, year);
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
async function sync(force = false) {
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

  const lastSyncStr = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync'").get()?.value;
  if (!force && lastSyncStr) {
    const lastSyncDate = new Date(lastSyncStr);
    if (!Number.isNaN(lastSyncDate.getTime())) {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      if (Date.now() - lastSyncDate.getTime() < thirtyDaysMs) {
        log.info('Holidays synced recently – skipping automatic sync.');
        return { synced: 0 };
      }
    }
  }

  // Sprache aus Land ableiten (Fallback EN)
  const langMap = {
    BR: 'PT',
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
