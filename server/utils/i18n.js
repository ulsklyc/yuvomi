/**
 * Server-i18n - Übersetzungen für serverseitig erzeugte Inhalte (#631, #632)
 *
 * Die Anzeigesprache eines Nutzers lebt im localStorage und ist dem Server nicht
 * bekannt. Für Inhalte, die der Server *speichert* statt nur ausliefert, reicht
 * das nicht: Geburtstags-Termine landen als Zeile in `calendar_events` und gehen
 * von dort in die REST-API, den ICS-Feed, den CalDAV-/Google-Outbound und den
 * FTS-Suchindex. Jeder dieser Kanäle sieht den gespeicherten Titel, keiner
 * durchläuft die clientseitige Übersetzung in `public/utils/birthday-event.js`.
 *
 * Deshalb hat der Haushalt eine eigene Datensprache (`language` in sync_config,
 * siehe resolveHouseholdLocale) - analog zu `currency`, `date_format` und
 * `week_start`, die ebenfalls haushaltweit sind. Sie bestimmt, in welcher Sprache
 * serverseitig erzeugte Titel und Beschreibungen abgelegt werden.
 *
 * Die Übersetzungen kommen aus denselben `public/locales/*.json`, die auch der
 * Client lädt - sie werden als Daten gelesen (readFileSync), nicht importiert.
 * Die Schichtgrenze aus `test/test-layer-boundary.js` bleibt damit gewahrt: es
 * gibt keinen Modul-Import über `public/` hinweg, und die Übersetzungen können
 * nicht auseinanderlaufen.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = fileURLToPath(new URL('../../public/locales/', import.meta.url));

// Referenz-Locale für fehlende Keys - dieselbe Rolle wie fallbackTranslations in
// public/i18n.js: `de` ist vollständig, jede andere Datei darf Lücken haben.
const REFERENCE_LOCALE = 'de';

// Default-Datensprache, wenn der Haushalt keine gesetzt und keine Region gewählt
// hat. Englisch, weil das exakt dem Verhalten vor der Preference entspricht
// ("Birthday: <Name>") - ein Bestandshaushalt erlebt so keinen stillen Wechsel.
const DEFAULT_LOCALE = 'en';

// Die Form, die BCP-47 fuer einen Locale-Dateinamen zulaesst: Sprache, optional
// Schrift, optional Region - `de`, `fil`, `pt-BR`, `zh-Hant`, `sr-Latn-RS`.
//
// Dieselbe Naht ist hier zweimal gerissen, beide Male an einer Laengenangabe,
// die genau den Bestand beschrieb statt die Regel. Erst forderte der
// Regionscode in preferences.js `{2}` und wies `fil-PH` ab; dann forderte
// dieses Muster `{2}` und verlor `fil.json` (#1322), waehrend das Auswahlmenue
// Filipino weiter anbot, weil es seine Optionen aus SUPPORTED_LOCALES im
// Frontend baut - `isSupportedLocale('fil')` war false und das Speichern
// antwortete mit 400. Nach `{2,3}` waere `zh-Hant.json` das dritte Mal gewesen.
//
// Die Erweiterung kostet nichts, solange sie eine Form beschreibt und keine
// beliebige Datei durchlaesst: `README.json` oder ein `de-de.json` mit
// kleingeschriebener Region bleiben draussen, sonst gaebe die Liste einem
// Nicht-Locale den Rang einer Sprache. Der Test dazu nagelt beide Richtungen
// fest, weil der Bestand selbst keine einzige dieser Formen traegt.
const LOCALE_FILE_RE = /^([a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?)\.json$/;

/**
 * Der Locale-Code eines Dateinamens, oder null. Exportiert, weil der Bestand
 * die Erweiterung nicht misst: alle 24 Dateien heissen `xx.json` oder
 * `xxx.json`, ein Test ueber getSupportedLocales() liefe an jeder Subtag-Form
 * vorbei. getSupportedLocales() ruft genau diese Funktion, es gibt also keinen
 * zweiten Pfad, der auseinanderlaufen koennte.
 */
export function localeFromFileName(file) {
  return file.match(LOCALE_FILE_RE)?.[1] ?? null;
}

let supportedLocales = null;
const localeCache = new Map();

/**
 * Alle Sprachen, für die eine Locale-Datei existiert. Die Dateien sind die
 * Wahrheit - so kann die Server-Liste nicht von SUPPORTED_LOCALES in
 * public/i18n.js abweichen, wenn dort eine Sprache dazukommt.
 * @returns {string[]} sortierte ISO-639-1-Codes
 */
export function getSupportedLocales() {
  if (supportedLocales) return supportedLocales;
  try {
    supportedLocales = readdirSync(LOCALES_DIR)
      .map(localeFromFileName)
      .filter(Boolean)
      .sort();
  } catch {
    supportedLocales = [DEFAULT_LOCALE];
  }
  if (!supportedLocales.length) supportedLocales = [DEFAULT_LOCALE];
  return supportedLocales;
}

/** Ist `locale` eine Sprache mit vorhandener Locale-Datei? */
export function isSupportedLocale(locale) {
  return typeof locale === 'string' && getSupportedLocales().includes(locale);
}

/**
 * Übersetzungsobjekt einer Sprache, gecacht. Liefert bei fehlender oder
 * kaputter Datei `null` statt zu werfen - eine Übersetzung darf nie der Grund
 * sein, warum ein Route-Handler 500 wirft.
 */
function loadLocale(locale) {
  if (localeCache.has(locale)) return localeCache.get(locale);
  let data = null;
  if (isSupportedLocale(locale)) {
    try {
      data = JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    } catch {
      data = null;
    }
  }
  localeCache.set(locale, data);
  return data;
}

/** Dot-Notation in verschachteltem Objekt auflösen (wie public/i18n.js). */
function resolveKey(obj, key) {
  return key.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/**
 * Übersetzt einen Key in die angegebene Sprache. Platzhalter-Syntax `{{name}}`,
 * identisch zu t() im Frontend.
 *
 * Fallback-Kette: Zielsprache → Englisch → Referenz-Locale → der Key selbst.
 * Englisch steht vor `de`, weil es die Default-Datensprache ist: fehlt ein Key
 * einmal in der schwedischen Datei, ist ein englischer Titel die kleinere
 * Überraschung als ein deutscher. Heute greift die Kette nicht, weil `test:i18n`
 * Schlüsselgleichheit über alle Locales erzwingt - sie ist die Absicherung für
 * den Fall, dass diese Zusage einmal gelockert wird.
 *
 * Ohne `count`-Pluralisierung: serverseitig erzeugte Texte sind Titel und
 * Beschreibungen einzelner Datensätze, keine Mengenangaben.
 *
 * @param {string} locale  ISO-639-1-Code
 * @param {string} key     Dot-Notation, z. B. 'birthdays.calendarEventTitle'
 * @param {object} params  Platzhalter-Werte
 * @returns {string}
 */
export function translate(locale, key, params = {}) {
  const chain = [isSupportedLocale(locale) ? locale : DEFAULT_LOCALE, DEFAULT_LOCALE, REFERENCE_LOCALE];

  let str;
  for (const candidate of chain) {
    const hit = resolveKey(loadLocale(candidate), key);
    // Ein Key, der auf einen Teilbaum zeigt, ist ein Aufruffehler und kein Text.
    // Ohne diese Prüfung würde das replaceAll unten mit einem TypeError brechen -
    // ausgerechnet in einer Funktion, die nie werfen soll.
    if (typeof hit === 'string') { str = hit; break; }
  }
  if (str === undefined) return key;

  // Ein Durchgang mit Callback statt einer Schleife aus replaceAll(string, string).
  // Zwei Gründe, beide an echten Namen nachvollziehbar:
  //   - Ein String-Ersatz interpretiert `$&`, `` $` `` und `$$`. Ein Kind namens
  //     "A $& B" wurde zu "A {{name}} B", und `` $` `` zog sogar den Text vor dem
  //     Treffer in den Namen ("X $` Y" → "X Geburtstag:  Y").
  //   - Nacheinander ersetzt, wird ein bereits eingesetzter Wert vom nächsten
  //     Platzhalter erneut durchsucht: ein Name "{{date}}" verwandelte sich beim
  //     date-Durchgang in das Datum.
  // Unbekannte Platzhalter bleiben stehen, statt zu verschwinden - so ist ein
  // fehlender Parameter im Ergebnis sichtbar und nicht still weggekürzt.
  return str.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
  ));
}

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'ymd_dot', 'ymd_slash'];

/**
 * Formatiert einen lokalen Datums-Key (YYYY-MM-DD) nach der Haushalts-Einstellung
 * `date_format`. Portiert formatDateParts() aus public/i18n.js, damit ein Datum
 * in einer gespeicherten Beschreibung genauso aussieht wie in der Oberfläche.
 *
 * Arbeitet bewusst auf dem String statt auf einem Date: `new Date('2026-03-01')`
 * ist UTC-Mitternacht und kippt westlich von UTC auf den Vortag.
 *
 * @param {string} dateKey     'YYYY-MM-DD'
 * @param {string} dateFormat  einer aus VALID_DATE_FORMATS
 * @returns {string}           formatiertes Datum, '' bei ungültiger Eingabe
 */
export function formatDateKey(dateKey, dateFormat = 'dmy') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? ''));
  if (!match) return '';
  const [, year, month, day] = match;
  switch (VALID_DATE_FORMATS.includes(dateFormat) ? dateFormat : 'dmy') {
    case 'mdy':       return `${month}/${day}/${year}`;
    case 'mdy_dot':   return `${month}.${day}.${year}`;
    case 'dmy_dot':   return `${day}.${month}.${year}`;
    case 'dmy_slash': return `${day}/${month}/${year}`;
    case 'ymd':       return `${year}-${month}-${day}`;
    case 'ymd_dot':   return `${year}.${month}.${day}`;
    case 'ymd_slash': return `${year}/${month}/${day}`;
    default:          return `${day}.${month}.${year}`;
  }
}

function cfgValue(database, key) {
  try {
    return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Datensprache des Haushalts.
 *
 * Reihenfolge: explizit gesetzte `language` → Sprachteil der `region`
 * (`de-DE` → `de`) → Englisch. Die Ableitung aus der Region ist der Grund,
 * warum die meisten Haushalte nichts einstellen müssen: wer seine Region auf
 * "Deutschland" gesetzt hat, bekommt deutsche Titel, ohne davon zu wissen.
 *
 * `ignoreExplicit` überspringt die erste Stufe und liefert, was die Automatik
 * ergäbe. Das braucht die Einstellungsseite für ihr "Automatisch (…)"-Label:
 * sonst nennt es bei explizit gewählter Sprache genau diese und verspricht dem
 * Nutzer eine Automatik, die er so nicht bekäme.
 *
 * Bewusst die *gespeicherte* Region, nicht die aus den Formaten abgeleitete:
 * ändert jemand nach der Regionswahl ein Format von Hand, springt der
 * Region-Dropdown auf "Benutzerdefiniert", während `sync_config.region` auf der
 * zuletzt gewählten Region stehen bleibt (#486 - genau dafür wurde sie
 * eingeführt). Die Datensprache folgt dann weiter dieser Wahl. Das ist die
 * bessere Antwort als der Gegenvorschlag, die Region bei jeder Formatänderung
 * zu verwerfen: ein anderes Datumsformat ist keine Aussage über die Sprache, und
 * ein deutscher Haushalt fiele dadurch auf englische Titel zurück. Der Preis ist
 * ein Dropdown, das "Benutzerdefiniert" zeigt, während das Sprach-Label eine
 * Region nennt - eine Erklärungslücke, kein falscher Wert.
 *
 * @param {object} database  better-sqlite3-Connection
 * @param {{ ignoreExplicit?: boolean }} options
 * @returns {string}
 */
export function resolveHouseholdLocale(database, { ignoreExplicit = false } = {}) {
  if (!ignoreExplicit) {
    const explicit = cfgValue(database, 'language');
    if (isSupportedLocale(explicit)) return explicit;
  }

  const regionLanguage = /^([a-z]{2,3})-[A-Z]{2}$/.exec(cfgValue(database, 'region') ?? '')?.[1];
  if (isSupportedLocale(regionLanguage)) return regionLanguage;

  return DEFAULT_LOCALE;
}

/**
 * Sprache, Datumsformat und Währung des Haushalts in einem Zug - alles drei
 * steckt in sync_config und wird von Aufrufern fast immer zusammen gebraucht.
 * @param {object} database
 * @returns {{ locale: string, dateFormat: string, currency: string }}
 */
export function resolveHouseholdFormats(database) {
  const dateFormat = cfgValue(database, 'date_format');
  return {
    locale: resolveHouseholdLocale(database),
    dateFormat: VALID_DATE_FORMATS.includes(dateFormat) ? dateFormat : 'dmy',
    currency: cfgValue(database, 'currency') || 'EUR',
  };
}

/**
 * Formatiert einen Betrag als Währung, wie es der Client mit `money()` tut.
 *
 * Die Zahlformatierung folgt der **Region**, nicht der Sprache - ein
 * deutschsprachiger Haushalt in der Schweiz schreibt `1'234.50`. Der Client
 * macht dasselbe über `getFormatLocale()`; hier ist die Region der volle
 * BCP-47-Tag aus sync_config, mit der Datensprache als Rückfall.
 *
 * Fehlerhafte Währungscodes lassen `Intl` werfen - dann bleibt die nackte Zahl
 * übrig, was besser ist als ein 500 aus einer Beschriftung.
 *
 * @param {number} amount
 * @param {{ locale: string, currency: string, region?: string|null }} opts
 * @returns {string}
 */
export function formatMoney(amount, { locale, currency, region = null }) {
  const numberLocale = /^[a-z]{2,3}-[A-Z]{2}$/.test(region ?? '') ? region : locale;
  try {
    return new Intl.NumberFormat(numberLocale, { style: 'currency', currency }).format(amount);
  } catch {
    return String(amount);
  }
}

/** Gespeicherte Region des Haushalts (voller BCP-47-Tag) oder null. */
export function householdRegion(database) {
  const region = cfgValue(database, 'region');
  return /^[a-z]{2,3}-[A-Z]{2}$/.test(region ?? '') ? region : null;
}

export { DEFAULT_LOCALE, REFERENCE_LOCALE };
