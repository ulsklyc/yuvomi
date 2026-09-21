/**
 * i18n - Internationalisierung / Übersetzungsmodul
 * Bietet t(), initI18n(), setLocale(), getLocale(), getSupportedLocales(),
 * formatDate(), formatTime() für die gesamte App.
 * Dependencies: none (vanilla JS, Fetch API, Intl API)
 */

// Relativ, nicht browser-absolut: mehrere Suiten laden i18n.js ohne den Loader
// aus test-browser-loader.mjs, und '/utils/...' waere dort das Dateisystem-Root.
// Im Browser loest './utils/timezone.js' von '/i18n.js' aus auf dasselbe auf.
import { zonedFields } from './utils/timezone.js';

const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it', 'sv', 'el', 'ru', 'tr', 'zh', 'ja', 'ar', 'hi', 'pt', 'uk', 'pl', 'nl', 'cs', 'vi', 'hu', 'ko', 'id', 'fa', 'fil'];
const RTL_LOCALES = new Set(['ar', 'fa']);
// Form eines Regions-Tags: Sprache, optional Schrift, dann die Region -
// `de-DE`, `fil-PH`, `zh-Hant-TW`. Eigene Konstante und kein Import aus
// server/: die Schichtgrenze aus test/test-layer-boundary.js laesst keinen
// Modulweg zwischen public/ und server/ zu. Das Gegenstueck heisst dort
// `REGION_RE` (server/utils/i18n.js), und test:region-presets haelt beide auf
// derselben Form - eine Region, die nur eine der beiden Seiten kennt, wuerde
// entweder beim Speichern abgewiesen oder gespeichert und nie gelesen.
export const REGION_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const DEFAULT_LOCALE = 'de';
const STORAGE_KEY = 'yuvomi-locale';
const DATE_FORMAT_KEY = 'yuvomi-date-format';
const TIME_FORMAT_KEY = 'yuvomi-time-format';
const NUMBER_LOCALE_KEY = 'yuvomi-number-locale';
const DEFAULT_DATE_FORMAT = 'dmy';
const DEFAULT_TIME_FORMAT = '24h';
const VALID_TIME_FORMATS = ['24h', '12h'];

let currentLocale = DEFAULT_LOCALE;
let translations = {};
let fallbackTranslations = {};
/** Third-party bundles: moduleId -> { defaultLocale, trees: { [locale]: nested } } */
let extensionLocaleStore = Object.create(null);
let i18nReady = false;
let resolveI18nReady;
const i18nReadyPromise = new Promise((resolve) => {
  resolveI18nReady = resolve;
});

function applyDocumentLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

// Regionen, die eine Schrift implizieren. Ein Browser meldet `zh-TW`, nie
// `zh-Hant-TW`: ohne diese Zuordnung fände ein taiwanisches System eine
// traditionelle Locale niemals von selbst, sie wäre nur über den manuellen
// Wähler erreichbar. `CN` und `SG` stehen bewusst NICHT hier - unser `zh` ist
// Vereinfacht, und genau darauf soll `zh-CN` fallen.
const REGION_SCRIPT = { TW: 'Hant', HK: 'Hant', MO: 'Hant' };

/**
 * Kanonische BCP-47-Schreibweise: Sprache klein, Schrift (vier Zeichen)
 * Titlecase, Region (zwei Zeichen) groß. Ein Browser darf `ZH-hant-tw` melden,
 * verglichen wird aber gegen Locale-Codes in kanonischer Form - ein Vergleich
 * über zwei Schreibweisen findet nie etwas.
 */
function canonicalTag(tag) {
  return String(tag).split('-').map((teil, i) => {
    if (i === 0) return teil.toLowerCase();
    if (teil.length === 4) return teil[0].toUpperCase() + teil.slice(1).toLowerCase();
    if (teil.length === 2) return teil.toUpperCase();
    return teil.toLowerCase();
  }).join('-');
}

/**
 * Wählt aus Browser-Tags die SPEZIFISCHSTE unterstützte Locale: exakter Treffer,
 * sonst die von der Region implizierte Schrift, sonst der Tag ohne seinen
 * letzten Subtag - `zh-Hant-TW` > `zh-Hant` > `zh`.
 *
 * Reine Funktion mit der Liste als Argument, weil sie sonst nicht messbar wäre:
 * der Bestand trägt 24 reine Sprachcodes, über die die alte und die neue
 * Auflösung dasselbe liefern. Erst eine Liste, die es hier noch nicht gibt,
 * beantwortet die Frage - `zh-TW` muss auf `zh-Hant` fallen, sobald diese Locale
 * existiert (#1320), und auf `zh`, solange sie es nicht tut.
 */
export function pickLocale(tags, supported) {
  for (const roh of tags || []) {
    if (!roh) continue;
    const teile = canonicalTag(roh).split('-');
    // Eine Schrift, die im Tag STEHT, schlaegt jede, die eine Region nur nahelegt.
    // `zh-Hans-HK` meint Vereinfacht in Hongkong, und macOS, iOS und Android melden
    // genau das. Ohne diese Sperre antwortet die Regionszuordnung darauf mit
    // Traditionell - also mit dem Gegenteil dessen, was ausdruecklich dasteht.
    const traegtSchrift = teile.slice(1).some((teil) => teil.length === 4);
    while (teile.length) {
      const tag = teile.join('-');
      if (supported.includes(tag)) return tag;
      if (!traegtSchrift) {
        const letzter = teile[teile.length - 1];
        const schrift = Object.hasOwn(REGION_SCRIPT, letzter) ? REGION_SCRIPT[letzter] : null;
        if (schrift && supported.includes(`${teile[0]}-${schrift}`)) return `${teile[0]}-${schrift}`;
      }
      teile.pop();
    }
  }
  return 'en';
}

/** Resolve locale: manual override > navigator.languages > English */
function resolveLocale() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;

  return pickLocale(navigator.languages || [navigator.language], SUPPORTED_LOCALES);
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
  _numberFormatCache.clear();
  _unitFormatCache.clear();
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

const pluralRulesCache = new Map();

function pluralCategory(locale, count) {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Liefert den Schlüssel, der für diese Anzahl gilt. Sprachen unterscheiden sich
 * in der Zahl der Formen (Deutsch 2, Polnisch 4, Japanisch 1), deshalb kommen
 * die Kategorien aus Intl.PluralRules und nicht aus einer `count === 1`-Abfrage.
 * Fehlt die Variante, greift `_other` und danach der nackte Schlüssel - so
 * bleiben Locales ohne Pluralvarianten unverändert nutzbar.
 */
function resolvePluralKey(key, count) {
  const category = pluralCategory(currentLocale, count);
  for (const candidate of [`${key}_${category}`, `${key}_other`, key]) {
    const extHit = resolveExtensionTranslation(candidate);
    if (typeof extHit === 'string') return extHit;
    const hit = resolve(translations, candidate)
      ?? resolve(fallbackTranslations, candidate);
    if (hit != null) return hit;
  }
  return key;
}

/**
 * Übersetzungsfunktion mit Platzhalter-Unterstützung {{variable}}.
 * Ein numerischer `count`-Parameter wählt zusätzlich die passende Pluralform
 * (`key_one`, `key_few`, … ), sofern die Locale sie definiert.
 *
 * Die Ersetzung läuft in einem Durchgang über ein Regex mit Callback, nicht in
 * einer Schleife aus replaceAll(string, string). Zwei Gründe, beide an echten
 * Nutzereingaben nachvollziehbar:
 *
 *   - Ein String als Ersatz interpretiert `$&`, `` $` ``, `$'` und `$$` als
 *     Rückverweise. Ein Kontakt namens "A $& B" wurde als "A {{name}} B"
 *     angezeigt, und `` $` `` zog den Text vor dem Treffer in den Namen hinein
 *     ("X $` Y" → "X Geburtstag:  Y").
 *   - Nacheinander ersetzt, durchsucht jeder weitere Platzhalter den bereits
 *     eingesetzten Wert erneut: ein Name "{{date}}" verwandelte sich beim
 *     date-Durchgang in das Datum.
 *
 * Unbekannte Platzhalter bleiben stehen, statt zu verschwinden - ein fehlender
 * Parameter soll im Ergebnis sichtbar sein und nicht still weggekürzt werden.
 */
export function t(key, params = {}) {
  let str;
  if (typeof params.count === 'number') {
    str = resolvePluralKey(key, params.count);
  } else {
    const extHit = resolveExtensionTranslation(key);
    str = extHit
      ?? resolve(translations, key)
      ?? resolve(fallbackTranslations, key)
      ?? key;
  }
  return str.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
  ));
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

/**
 * Nachgestelltes Zeitwort der Locale („Uhr", „ч."). Gilt nur für die
 * 24-Stunden-Schreibweise - „3:00 PM Uhr" mischt zwei Systeme und liest sich
 * falsch, deshalb liefert der Helfer im 12-Stunden-Format einen leeren String.
 * Aufrufer hängen ihn mit `${time} ${timeSuffix()}`.trimEnd() an.
 */
export function timeSuffix() {
  return getTimeFormatPreference() === '12h' ? '' : t('calendar.timeSuffix');
}

/**
 * Datums-Bestandteile in der Schreibweise der Präferenz.
 *
 * Die Zone steckt in `zonedFields()` (utils/timezone.js), nicht hier: ein
 * Zeitpunkt wird in die Haushaltszone umgerechnet, eine zonenlose Wanduhrzeit
 * und ein reines Datum werden gelesen. Vor #829 Teil 3 stand an dieser Stelle
 * ein `useUtc`-Schalter, der genau eine dieser drei Formen abdeckte - das reine
 * Datum, über den Umweg `new Date(`${d}T00:00:00Z`)` plus UTC-Gettern.
 */
function formatDateParts(date) {
  const f = zonedFields(date);
  if (!f) return '';
  const year = f.year;
  const month = String(f.month).padStart(2, '0');
  const day = String(f.day).padStart(2, '0');
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

/** Core fallback chain for extension modules (UI locale -> module default -> en -> de). */
export const EXTENSION_LOCALE_FALLBACKS = ['en', DEFAULT_LOCALE];

export function nestFlatLocaleDict(flatDict) {
  const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
  const moduleRoot = Object.create(null);
  for (const [key, value] of Object.entries(flatDict || {})) {
    if (typeof value !== 'string') continue;
    const parts = String(key).trim().split('.');
    if (parts.some((p) => !p || DANGEROUS.has(p))) continue;
    let node = moduleRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!Object.prototype.hasOwnProperty.call(node, parts[i]) || typeof node[parts[i]] !== 'object') {
        node[parts[i]] = Object.create(null);
      }
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return moduleRoot;
}

function extensionLocaleChain(moduleDefault, locale = currentLocale) {
  return [...new Set([locale, moduleDefault, ...EXTENSION_LOCALE_FALLBACKS].filter(Boolean))];
}

function resolveExtensionTranslation(key, locale = currentLocale) {
  if (!key.startsWith('extensions.')) return undefined;
  const rest = key.slice('extensions.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return undefined;
  const moduleId = rest.slice(0, dot);
  const subKey = rest.slice(dot + 1);
  const store = extensionLocaleStore[moduleId];
  if (!store) return undefined;
  for (const loc of extensionLocaleChain(store.defaultLocale, locale)) {
    const tree = store.trees[loc];
    if (!tree) continue;
    const hit = resolve(tree, subKey);
    if (typeof hit === 'string') return hit;
  }
  return undefined;
}

/**
 * Third-party module locale bundles. Pass every shipped locales/{code}.json tree;
 * lookup walks UI locale -> module defaultLocale -> en -> de.
 */
export function setExtensionLocaleBundles(moduleId, { defaultLocale = 'en', trees = {} } = {}) {
  extensionLocaleStore[moduleId] = {
    defaultLocale,
    trees: trees && typeof trees === 'object' ? trees : {},
  };
}

export function clearExtensionLocaleBundles(moduleId) {
  delete extensionLocaleStore[moduleId];
}

/** @deprecated Use setExtensionLocaleBundles — kept for tests and single-locale shortcuts. */
export function registerExtensionTranslations(moduleId, flatDict) {
  setExtensionLocaleBundles(moduleId, {
    defaultLocale: 'en',
    trees: { en: nestFlatLocaleDict(flatDict) },
  });
}

export function unregisterExtensionTranslations(moduleId) {
  clearExtensionLocaleBundles(moduleId);
}

export function clearExtensionTranslations() {
  extensionLocaleStore = Object.create(null);
}

export { resolveExtensionTranslation, extensionLocaleChain };

/**
 * Locale für Zahlen-/Währungsformatierung (Intl.NumberFormat).
 * Nutzt die gespeicherte Region (voller BCP-47-Tag, z. B. "de-CH" für Schweizer
 * Gruppierung 123'456.78), damit Zahlenformate unabhängig von der UI-Sprache
 * der Region folgen. Fällt auf die UI-Sprache zurück, wenn keine Region gesetzt
 * ist. Siehe numberLocaleFor() in settings/region-presets.js für die Ableitung.
 */
export function getFormatLocale() {
  let stored = null;
  try {
    stored = localStorage.getItem(NUMBER_LOCALE_KEY);
  } catch {
    stored = null;
  }
  return stored && REGION_TAG.test(stored) ? stored : currentLocale;
}

// Gecachte Intl.NumberFormat-Instanzen je (Format-Locale × Options). Die
// Konstruktion eines NumberFormat ist teuer; ohne Cache baut jede formatierte
// Zahl auf einer Budget-/Dashboard-Seite einen neuen Formatter. Der Schlüssel
// enthält getFormatLocale(), sodass ein Sprach-/Regionswechsel automatisch einen
// neuen Formatter erzeugt; zusätzlich leert 'locale-changed' den Cache.
const _numberFormatCache = new Map();

/**
 * Liefert einen gecachten Intl.NumberFormat für die aktuelle Format-Locale
 * (region-abhängig via getFormatLocale). Ersetzt `new Intl.NumberFormat(
 * getFormatLocale(), options)` an den Aufrufstellen, damit Formatter nicht pro
 * Wert neu gebaut werden.
 */
export function getNumberFormat(options = {}) {
  const locale = getFormatLocale();
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let fmt = _numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    _numberFormatCache.set(key, fmt);
  }
  return fmt;
}

// Die Zahlteile eines formatToParts-Ergebnisses. Was dazwischen oder daneben
// steht (Einheitswort, Leerzeichen, Richtungsmarken), gehört der Sprache.
const NUMBER_PARTS = new Set(['minusSign', 'plusSign', 'integer', 'group', 'decimal', 'fraction']);
// Eine Richtungsmarke direkt vor dem Vorzeichen gehört zur Zahl: `ar-SA` setzt
// ein ALM vor das Minus, `fa-IR` ein LRM. Sie wandert mit der Zahl aus.
const BIDI_MARK = /^[\u061c\u200e\u200f]+$/;

// Gecachte Formatter-Paare je (UI-Sprache × Format-Locale × Einheit × Options),
// aus demselben Grund wie _numberFormatCache. Beide Locales stehen im Schlüssel:
// ein Sprachwechsel ändert das Wort, ein Regionswechsel die Ziffern, und die
// Region wechselt ohne setLocale() (Einstellungen, Abgleich der
// Haushaltseinstellungen im Router). setLocale() leert den Cache zusätzlich,
// bevor es 'locale-changed' meldet.
const _unitFormatCache = new Map();

/**
 * Formatiert einen Wert mit Einheit („3 weeks", „1 Tg. 1 Std."): die Zahl gehört
 * dem Haushalt, das Wort der Person (#1365).
 *
 * Wort, Pluralform und Wortstellung kommen aus der UI-Sprache (CLDR über
 * `style: 'unit'`), die Zahlteile - Ziffern, Dezimal- und Tausendertrenner,
 * Vorzeichen - aus der Region (`getFormatLocale()`), wie jede andere Zahl und
 * jeder Betrag daneben (#521). Eine zusammengesetzte Locale aus Sprache und
 * Regions-Land (`en-DE`) kennt ICU nur für wenige Paare und fällt still zurück;
 * deshalb zwei Formatter und ein Tausch der Zahl über formatToParts.
 *
 * Die Zahl der Sprache ist der Abschnitt vom ersten bis zum letzten Zahlteil,
 * samt einer Richtungsmarke direkt davor. An ihre Stelle tritt die Zahl der
 * Region vollständig. Hat das Ergebnis der Sprache gar keinen Zahlteil
 * (Arabisch 1 und 2: „أسبوع", „أسبوعان"), bleibt es unverändert.
 *
 * `style: 'unit'` steht nur hier; test:region-presets hält das fest.
 *
 * @param {number} value
 * @param {string} unit  Intl-Einheit, z. B. 'day', 'hour', 'week'
 * @param {Intl.NumberFormatOptions} [options]  `unitDisplay` und Zifferoptionen
 * @returns {string}
 */
export function formatUnit(value, unit, options = {}) {
  const language = currentLocale;
  const region = getFormatLocale();
  const key = `${language}\u0000${region}\u0000${unit}\u0000${JSON.stringify(options)}`;
  let pair = _unitFormatCache.get(key);
  if (!pair) {
    const { unitDisplay, ...digits } = options;
    pair = {
      word: new Intl.NumberFormat(language, { ...digits, style: 'unit', unit, unitDisplay }),
      number: new Intl.NumberFormat(region, digits),
    };
    _unitFormatCache.set(key, pair);
  }
  const parts = pair.word.formatToParts(value);
  let first = parts.findIndex((part) => NUMBER_PARTS.has(part.type));
  if (first === -1) return parts.map((part) => part.value).join('');
  const last = parts.findLastIndex((part) => NUMBER_PARTS.has(part.type));
  while (first > 0 && parts[first - 1].type === 'literal' && BIDI_MARK.test(parts[first - 1].value)) first--;
  return [
    ...parts.slice(0, first).map((part) => part.value),
    pair.number.format(value),
    ...parts.slice(last + 1).map((part) => part.value),
  ].join('');
}

/** Liste der unterstützten Locales */
export function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

/** Datum locale-aware formatieren */
export function formatDate(date) {
  if (date == null) return '';
  return formatDateParts(date);
}

/**
 * Kompaktes Datum ohne Jahr (z. B. Spaltenköpfe im Wochenboard, Audit F-04):
 * folgt der Datumsformat-Präferenz in Reihenfolge und Trennzeichen, lässt nur
 * das Jahr weg — der umgebende Kontext (Wochen-Label) trägt es bereits.
 */
export function formatDayMonth(date) {
  if (date == null) return '';
  const f = zonedFields(date);
  if (!f) return '';
  const month = String(f.month).padStart(2, '0');
  const day = String(f.day).padStart(2, '0');
  switch (getDateFormatPreference()) {
    case 'dmy': return `${day}.${month}.`;
    case 'mdy_dot': return `${month}.${day}.`;
    case 'dmy_dot': return `${day}.${month}.`;
    case 'dmy_slash': return `${day}/${month}`;
    case 'ymd': return `${month}-${day}`;
    case 'ymd_dot': return `${month}.${day}.`;
    case 'ymd_slash': return `${month}/${day}`;
    default: return `${month}/${day}`;
  }
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

// Gecachter 24-Stunden-Formatter je UI-Locale. Wie bei _numberFormatCache ist
// die Konstruktion teuer, und eine Agenda formatiert Dutzende Zeiten pro Render.
const _timeFormatCache = new Map();

function hourMinuteFormat() {
  let fmt = _timeFormatCache.get(currentLocale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(currentLocale, {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
    _timeFormatCache.set(currentLocale, fmt);
  }
  return fmt;
}

/** Uhrzeit locale-aware formatieren */
export function formatTime(date) {
  if (date == null) return '';
  // Eine reine Uhrzeit ('09:00') ist definitionsgemäß Wanduhrzeit - sie hat kein
  // Datum, an dem eine Zone greifen könnte. Sie muss VOR zonedFields abgefangen
  // werden: als `new Date(2000, 0, 1, 9, 0)` verpackt wäre sie ein Zeitpunkt, und
  // eine gesetzte Haushaltszone verschöbe die Stundenleiste der Wochenansicht um
  // ihren Offset.
  const wall = typeof date === 'string' && !/\d{4}-\d{2}-\d{2}/.test(date)
    ? toTimeParts(date) : null;
  const f = wall ? { ...wall, second: 0 } : zonedFields(date);
  if (!f) return '';
  if (getTimeFormatPreference() === '12h') {
    const displayHour = f.hour % 12 || 12;
    return `${displayHour}:${String(f.minute).padStart(2, '0')} ${f.hour >= 12 ? 'PM' : 'AM'}`;
  }
  // Weiter über Intl, aber mit der Wanduhr der Anzeigezone als UTC-Date und
  // `timeZone: 'UTC'`: so bleibt die Schreibweise der Locale erhalten - `id`
  // trennt mit einem Punkt, `fa` schreibt persische Ziffern - ohne dass der
  // Formatter selbst noch einmal in die Browser-Zone umrechnet.
  // Der Referenztag ist beliebig - der Formatter liest nur Stunde und Minute.
  return hourMinuteFormat().format(Date.UTC(f.year ?? 2000, (f.month ?? 1) - 1, f.day ?? 1, f.hour, f.minute, f.second));
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

  // Getrennte Schreibweisen: ':', '.', ',' oder 'h' als Trennzeichen zwischen
  // Stunde und Minute. Erleichtert die Eingabe auf Tastaturen, auf denen der
  // Doppelpunkt umständlich ist (z. B. 09.30 oder 9h30 → 09:30).
  const sepMatch = raw.match(/^(\d{1,2})[:.,hH](\d{2})$/);
  if (sepMatch) {
    const hour = Number(sepMatch[1]);
    const minute = Number(sepMatch[2]);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return { hour, minute };
    }
    return null;
  }

  // Kompakte Schreibweise ohne Trennzeichen: HMM oder HHMM (3–4 Ziffern).
  // Die letzten zwei Ziffern sind die Minuten, der Rest die Stunde
  // (930 → 09:30, 0930 → 09:30, 1345 → 13:45). Vierstellige Werte kollidieren
  // nicht mit dem 1–2-stelligen Stunden-Fall darüber.
  if (/^\d{3,4}$/.test(raw)) {
    const hour = Number(raw.slice(0, -2));
    const minute = Number(raw.slice(-2));
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
