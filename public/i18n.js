/**
 * i18n - Internationalisierung / Übersetzungsmodul
 * Bietet t(), initI18n(), setLocale(), getLocale(), getSupportedLocales(),
 * formatDate(), formatTime() für die gesamte App.
 * Dependencies: none (vanilla JS, Fetch API, Intl API)
 */

const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it', 'sv', 'el', 'ru', 'tr', 'zh', 'ja', 'ar', 'hi', 'pt', 'uk', 'pl', 'nl', 'cs', 'vi', 'hu'];
const RTL_LOCALES = new Set(['ar']);
const DEFAULT_LOCALE = 'de';
const STORAGE_KEY = 'oikos-locale';
const DATE_FORMAT_KEY = 'oikos-date-format';
const TIME_FORMAT_KEY = 'oikos-time-format';
const DEFAULT_DATE_FORMAT = 'dmy';
const DEFAULT_TIME_FORMAT = '24h';
const VALID_TIME_FORMATS = ['24h', '12h'];

let currentLocale = DEFAULT_LOCALE;
let translations = {};
let fallbackTranslations = {};
let i18nReady = false;
let resolveI18nReady;
const i18nReadyPromise = new Promise((resolve) => {
  resolveI18nReady = resolve;
});

function applyDocumentLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

/** Resolve locale: manual override > navigator.language > English > default */
function resolveLocale() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;

  const browserLocales = navigator.languages || [navigator.language];
  for (const tag of browserLocales) {
    const base = tag.split('-')[0].toLowerCase();
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return 'en';
}

/** Lade eine Locale-JSON-Datei */
async function loadLocale(locale) {
  const resp = await fetch(`/locales/${locale}.json`);
  if (!resp.ok) throw new Error(`Failed to load locale: ${locale}`);
  return resp.json();
}

/** Initialisierung - einmal beim App-Start aufrufen */
export async function initI18n() {
  currentLocale = resolveLocale();
  fallbackTranslations = await loadLocale(DEFAULT_LOCALE);
  if (currentLocale !== DEFAULT_LOCALE) {
    try {
      translations = await loadLocale(currentLocale);
    } catch {
      translations = fallbackTranslations;
      currentLocale = DEFAULT_LOCALE;
    }
  } else {
    translations = fallbackTranslations;
  }
  applyDocumentLocale(currentLocale);
  i18nReady = true;
  resolveI18nReady();
  window.dispatchEvent(new CustomEvent('i18n-ready', { detail: { locale: currentLocale } }));
}

/** Warten bis die erste Locale geladen wurde */
export function whenI18nReady() {
  return i18nReady ? Promise.resolve() : i18nReadyPromise;
}

/** Sprache wechseln - löst 'locale-changed' Event aus */
export async function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  localStorage.setItem(STORAGE_KEY, locale);
  currentLocale = locale;
  const loaded = locale === DEFAULT_LOCALE
    ? fallbackTranslations
    : await loadLocale(locale);
  if (currentLocale !== locale) return;
  translations = loaded;
  applyDocumentLocale(locale);
  window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale } }));
}

/** Hilfsfunktion: Dot-Notation in verschachteltem Objekt auflösen */
function resolve(obj, key) {
  return key.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/** Übersetzungsfunktion mit Platzhalter-Unterstützung {{variable}} */
export function t(key, params = {}) {
  let str = resolve(translations, key) ?? resolve(fallbackTranslations, key) ?? key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{{${k}}}`, String(v));
  }
  return str;
}

function isDateOnlyString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'ymd_dot', 'ymd_slash'];

function getDateFormatPreference() {
  const stored = localStorage.getItem(DATE_FORMAT_KEY);
  return VALID_DATE_FORMATS.includes(stored) ? stored : DEFAULT_DATE_FORMAT;
}

export function getDateFormat() {
  return getDateFormatPreference();
}

function getTimeFormatPreference() {
  const stored = localStorage.getItem(TIME_FORMAT_KEY);
  return VALID_TIME_FORMATS.includes(stored) ? stored : DEFAULT_TIME_FORMAT;
}

export function getTimeFormat() {
  return getTimeFormatPreference();
}

function formatDateParts(date, useUtc = false) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const year = useUtc ? d.getUTCFullYear() : d.getFullYear();
  const month = String((useUtc ? d.getUTCMonth() : d.getMonth()) + 1).padStart(2, '0');
  const day = String(useUtc ? d.getUTCDate() : d.getDate()).padStart(2, '0');
  switch (getDateFormatPreference()) {
    case 'dmy': return `${day}.${month}.${year}`;
    case 'mdy_dot': return `${month}.${day}.${year}`;
    case 'dmy_dot': return `${day}.${month}.${year}`;
    case 'dmy_slash': return `${day}/${month}/${year}`;
    case 'ymd': return `${year}-${month}-${day}`;
    case 'ymd_dot': return `${year}.${month}.${day}`;
    case 'ymd_slash': return `${year}/${month}/${day}`;
    default: return `${month}/${day}/${year}`;
  }
}

/** Aktuelle Locale abfragen */
export function getLocale() {
  return currentLocale;
}

/** Liste der unterstützten Locales */
export function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

/** Datum locale-aware formatieren */
export function formatDate(date) {
  if (date == null) return '';
  if (isDateOnlyString(date)) {
    return formatDateParts(new Date(`${date}T00:00:00Z`), true);
  }
  return formatDateParts(date);
}

export function dateInputPlaceholder() {
  switch (getDateFormatPreference()) {
    case 'dmy': return 'DD.MM.YYYY';
    case 'mdy_dot': return 'MM.DD.YYYY';
    case 'dmy_dot': return 'DD.MM.YYYY';
    case 'dmy_slash': return 'DD/MM/YYYY';
    case 'ymd': return 'YYYY-MM-DD';
    case 'ymd_dot': return 'YYYY.MM.DD';
    case 'ymd_slash': return 'YYYY/MM/DD';
    default: return 'MM/DD/YYYY';
  }
}

export function formatDateInput(date) {
  if (!date) return '';
  return formatDate(date);
}

export function parseDateInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return isValidDateParts(isoMatch[1], isoMatch[2], isoMatch[3]) ? raw : '';

  if (/^\d{8}$/.test(raw)) {
    const pref = getDateFormatPreference();
    let year, month, day;
    if (pref.startsWith('ymd')) {
      year = raw.slice(0, 4); month = raw.slice(4, 6); day = raw.slice(6, 8);
    } else if (pref.startsWith('dmy')) {
      day = raw.slice(0, 2); month = raw.slice(2, 4); year = raw.slice(4, 8);
    } else {
      month = raw.slice(0, 2); day = raw.slice(2, 4); year = raw.slice(4, 8);
    }
    if (!isValidDateParts(year, month, day)) return '';
    return `${year}-${month}-${day}`;
  }

  const ymdSeparatorMatch = raw.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (ymdSeparatorMatch && getDateFormatPreference().startsWith('ymd')) {
    const [, year, month, day] = ymdSeparatorMatch;
    if (!isValidDateParts(year, month, day)) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!slashMatch) return '';

  const [, first, second, year] = slashMatch;
  const [month, day] = getDateFormatPreference().startsWith('dmy')
    ? [second, first]
    : [first, second];

  if (!isValidDateParts(year, month, day)) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isDateInputValid(value) {
  const raw = String(value || '').trim();
  return !raw || !!parseDateInput(raw);
}

function isValidDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Uhrzeit locale-aware formatieren */
export function formatTime(date) {
  if (date == null) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  if (getTimeFormatPreference() === '12h') {
    const hour = d.getHours();
    const minute = String(d.getMinutes()).padStart(2, '0');
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
  }
  return new Intl.DateTimeFormat(currentLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function toTimeParts(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return { hour: value.getHours(), minute: value.getMinutes() };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{1,2}$/.test(raw)) {
    const hour = Number(raw);
    return (hour >= 0 && hour <= 23) ? { hour, minute: 0 } : null;
  }

  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [hour, minute] = raw.split(':').map(Number);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return { hour, minute };
    }
    return null;
  }

  const ampmMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]);
    const minute = Number(ampmMatch[2] ?? 0);
    const meridiem = ampmMatch[3].toLowerCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute >= 60) return null;
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  return null;
}

export function formatTimeInput(value) {
  const parts = toTimeParts(value);
  if (!parts) return '';
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  if (getTimeFormatPreference() === '12h') {
    const isPm = parts.hour >= 12;
    const displayHour = parts.hour % 12 || 12;
    return `${displayHour}:${minute} ${isPm ? 'PM' : 'AM'}`;
  }
  return `${hour}:${minute}`;
}

export function parseTimeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = toTimeParts(raw);
  if (!parts) return '';
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function isTimeInputValid(value) {
  return !String(value || '').trim() || !!parseTimeInput(value);
}

export function timeInputPlaceholder() {
  return getTimeFormatPreference() === '12h' ? 'h:mm AM/PM' : 'HH:MM';
}
