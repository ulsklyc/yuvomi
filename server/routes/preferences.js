/**
 * Modul: Haushalt-Einstellungen (Preferences)
 * Zweck: REST-API fuer haushaltweite Praeferenzen (via sync_config-Tabelle)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as holidays from '../services/holidays.js';
import { str, MAX_SHORT } from '../middleware/validate.js';
import { getSupportedLocales, isSupportedLocale, resolveHouseholdLocale } from '../utils/i18n.js';
import { householdTimeZone, isValidTimeZone } from '../utils/timezone.js';
import { retitleBirthdayEvents } from '../services/birthdays.js';
import { DEFAULT_OVERDUE_GRACE_DAYS } from '../services/countdowns.js';
import { isWidgetId } from '../services/module-capabilities.js';
import { listVisibleCategories } from '../services/note-categories.js';
// Geteilte isomorphe Util (#620, Allowlist in test/test-layer-boundary.js):
// dasselbe Kennungsformat, das Event-Modal und Einstellungen verwenden.
import { parseSyncTargetValue } from '../../public/utils/sync-target.js';
// Der Vorrat waehlbarer Waehrungen - eine Liste fuer Server und Browser
// (#841, Allowlist in test/test-layer-boundary.js).
import { CURRENCY_CODES } from '../../public/utils/currency-codes.js';

const log = createLogger('Preferences');

const router = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_MEAL_TYPES = VALID_MEAL_TYPES.join(',');

/* HAUSHALTSNAMEN DER VIER SLOTS (#1058).
 *
 * Ein Name je Slot, wie der Haushalt ihn tippt - KEINE Uebersetzung. Er steht
 * in jeder Sprache so da, wie er eingegeben wurde: `fr`, `fr-CA` und `fr-BE`
 * sind sich beim Abendessen nicht einig, und keine Locale-Datei kann das je
 * Haushalt aufloesen. Ein leerer Name heisst "nimm das eingebaute Wort".
 *
 * ALS JSON, NICHT KOMMASEPARIERT wie `visible_meal_types` nebenan: ein Name
 * darf ein Komma enthalten ("Znuni, spaet"), und ein `split(',')` machte
 * daraus zwei. Derselbe Grund, aus dem ein Doppelpunkt-Schluessel kein
 * `split(':')` vertraegt.
 *
 * Der Slot-SCHLUESSEL bleibt unberuehrt - `meals.meal_type` traegt eine
 * CHECK-Constraint, Rezept-Eignung und die Mealie/Tandoor-Zuordnung haengen
 * daran. Umbenennen ist deshalb ein Anzeigename ueber einem stabilen Wert und
 * migriert nichts (#514). */
const MAX_MEAL_TYPE_NAME = 40;

/** Gespeicherte Namen als Objekt - unbekannte Slots und leere Werte fallen weg. */
function parseMealTypeNames(raw) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  // Allowlist statt Denylist: ein Slot, den es nicht (mehr) gibt, kommt nicht
  // durch, egal was in der Zeile steht.
  for (const type of VALID_MEAL_TYPES) {
    const value = typeof parsed[type] === 'string' ? parsed[type].trim() : '';
    if (value) out[type] = value.slice(0, MAX_MEAL_TYPE_NAME);
  }
  return out;
}

const DEFAULT_CURRENCY = 'EUR';
const DEFAULT_APP_NAME = 'Yuvomi';

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'ymd_dot', 'ymd_slash'];
// Default an die übrigen europäischen Defaults (EUR, 24h) und den Client-i18n-
// Default (dmy) angeglichen: ein nicht konfigurierter Account zeigt 30.06.2026
// statt 06/30/2026. US-Nutzer können in den Einstellungen weiterhin mdy wählen.
const DEFAULT_DATE_FORMAT = 'dmy';
const VALID_TIME_FORMATS = ['24h', '12h'];

// Wochenstart (haushaltweit): mit welchem Wochentag Kalender-Ansichten beginnen.
// Montag = bisheriges Fixverhalten; Sonntag/Samstag auf mehrfachen Nutzerwunsch
// (#484, #465). Als Klartext gespeichert – der Client mappt auf den getDay()-Index.
const VALID_WEEK_STARTS = ['monday', 'sunday', 'saturday'];
const DEFAULT_WEEK_START = 'monday';
// Budget-Modus (#476/#505): 'shared' = ein Haushaltsbudget (Altverhalten),
// 'personal' = persönliche/geteilte Einträge mit Mein/Haushalt-Ansicht.
const VALID_BUDGET_MODES = ['shared', 'personal'];
const DEFAULT_BUDGET_MODE = 'shared';

// Datensprache des Haushalts (#631, #632): in welcher Sprache der Server Inhalte
// *speichert*, die er selbst erzeugt - heute die Titel und Beschreibungen der
// Geburtstags-Termine. Anders als die UI-Sprache (per-user im localStorage) muss
// das haushaltweit sein: eine calendar_events-Zeile hat genau einen Titel, und
// den lesen REST-API, ICS-Feed, CalDAV-/Google-Outbound und die Suche.
// Nicht gesetzt = aus der Region abgeleitet, sonst Englisch (resolveHouseholdLocale).
const VALID_LANGUAGES = getSupportedLocales();

// Region ist nur ein Anzeige-Hinweis (Locale-Code wie "fr-FR" oder "custom").
// Der Client fällt bei unbekanntem Wert ohnehin auf detectRegion() zurück, daher
// genügt eine Formprüfung statt einer festen Liste.
//
// Der Sprachteil darf zwei oder drei Buchstaben haben: BCP-47 kennt beides und
// "fil-PH" (Filipino) wäre mit der alten {2}-Prüfung als ungültige Region
// abgewiesen worden, obwohl der Client sie anbietet.
const VALID_REGION = /^(custom|[a-z]{2,3}-[A-Z]{2})$/;
const DEFAULT_TIME_FORMAT = '24h';

// Zeitzone des Haushalts (#829, haushaltweit). Bis hierher war die einzige
// Antwort auf "wo lebt dieser Haushalt" die Container-Variable `TZ` - ein
// Compose-Schalter, den man auf Umbrel, TrueNAS oder Unraid als Nutzer nicht
// erreicht, und der zugleich Logzeitstempel und Backup-Cron steuert. Als
// Einstellung ist sie änderbar, überlebt ein Deployment, das die Env verliert,
// und lässt sich prüfen.
//
// Leerer Wert = nicht gesetzt = der bisherige Rückfall (TZ → Systemzone → UTC),
// damit ein Bestandshaushalt beim Update nichts merkt.
//
// Geprüft wird gegen ICU (`isValidTimeZone`), nicht gegen eine Liste im Repo:
// eine gepflegte Konstante liefe von dem, was `Intl` tatsächlich kennt,
// auseinander, und zwar genau dort, wo es niemandem auffällt. Bewusst nicht
// gegen `Intl.supportedValuesOf('timeZone')` - das gibt nur die kanonischen
// Namen zurück und wiese einen gültigen Alias wie `Europe/Kiev` ab. Die Liste
// fürs Dropdown baut der Client aus seinem eigenen ICU; ein Wert, den nur er
// kennt, bekommt hier ein 400 statt still zu landen.

// Standard-Termindauer (Minuten): setzt das Ende neuer Kalender-Termine relativ
// zum Start und dient dem Modal als Ausgangs-Dauer. Grenzen: 5 Min bis 24 h.
const DEFAULT_CALENDAR_DURATION = 60;
const MIN_CALENDAR_DURATION = 5;
const MAX_CALENDAR_DURATION = 1440;

// Standard-Erinnerungen für neue Termine (#497, per-user): erlaubte Offsets in
// Minuten vor Terminbeginn (deckt sich mit den Presets im Event-Modal). Cap = 5,
// analog MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js.
const VALID_REMINDER_OFFSETS = [0, 15, 60, 1440, 2880, 10080, 20160];
const MAX_DEFAULT_REMINDERS = 5;

// Standard-Sync-Ziel für eigene neue Termine (#620, per-user). Gespeichert wird
// exakt die Kennung, die das Event-Modal ohnehin führt: '' (lokal speichern),
// 'google:<calendarId>' oder 'caldav:<accountId>|<calendarUrl>'. Geprüft wird mit
// parseSyncTargetValue aus dem geteilten Util - dieselbe Funktion, mit der das
// Frontend die Kennung baut und liest, damit Server und Client nicht getrennte
// Vorstellungen vom Format entwickeln.
//
// Geprüft wird nur die FORM, nicht die Existenz. Ein Kalender kann deaktiviert,
// gelöscht oder auf nur-lesend gestellt werden, lange nachdem jemand ihn hier
// gewählt hat; eine Existenzprüfung beim Speichern würde das nicht verhindern,
// aber einen Google-API-Aufruf in jeden Einstellungs-Save ziehen. Stattdessen
// entscheidet das Modal beim Öffnen: steht das Ziel nicht mehr in der Liste,
// bleibt die Vorauswahl auf "Lokal" (siehe applyDefaultSyncTarget).
//
// Per-user, kein Admin-Gate: die Nachbarschlüssel calendar_default_reminders und
// calendar_default_assign_me liegen aus demselben Grund pro Nutzer (#497/#498) -
// wer welchen Kalender bespielt, ist eine persönliche Entscheidung.
const MAX_CALENDAR_TARGET_LENGTH = 500;

// Standard-Punktwert für neue Aufgaben (#578, haushaltweit). 0 = kein Standard,
// das Punktefeld bleibt wie bisher leer. Obergrenze spiegelt MAX_POINTS in
// server/routes/tasks.js.
const DEFAULT_TASK_POINTS = 0;
const MAX_TASK_POINTS = 10000;

// Obergrenze für die Countdown-Nachfrist in Tagen (#969, haushaltweit). Der
// Standard selbst kommt aus services/countdowns.js - eine Kopie hier wäre eine
// zweite Antwort, die von der ersten abweichen könnte (docs/DECISIONS.md #2).
const MAX_COUNTDOWN_GRACE_DAYS = 90;

// Persistierte Default-Reminder als sortiertes Zahlen-Array lesen (leer = keine).
function parseDefaultReminders(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map(Number).filter((n) => VALID_REMINDER_OFFSETS.includes(n)))]
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Persistierten Standard-Punktwert als ganze Zahl im gültigen Bereich lesen. */
function parseTaskDefaultPoints(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_POINTS;
  return Math.min(n, MAX_TASK_POINTS);
}

/**
 * Persistierte Countdown-Nachfrist lesen - anders als parseTaskDefaultPoints
 * ist hier `0` ein gültiger, bewusst gesetzter Wert ("keine Nachfrist") und
 * fällt nicht auf den Standard zurück.
 */
function parseCountdownGraceDays(raw) {
  if (raw === null || raw === undefined) return DEFAULT_OVERDUE_GRACE_DAYS;
  const n = Math.trunc(Number(raw));
  if (!Number.isInteger(n) || n < 0) return DEFAULT_OVERDUE_GRACE_DAYS;
  return Math.min(n, MAX_COUNTDOWN_GRACE_DAYS);
}

const VALID_WEATHER_PROVIDERS = ['open-meteo', 'openweathermap'];
const VALID_WEATHER_UNITS = ['metric', 'imperial'];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9-]{1,10}$/;

// Widget identifiers are client-owned. The server validates only a safe storage shape,
// so adding or removing dashboard widgets never requires a matching backend registry
// change. Die Schreibweise selbst steht in services/module-capabilities.js - dort, wo
// `fullWidgetId()` sie zusammensetzt. Eine zweite Fassung hier hat #1013 verursacht:
// sie kannte den Doppelpunkt der Fremdmodul-Ids nicht.
const MAX_DASHBOARD_WIDGETS = 64;
const VALID_WIDGET_SIZES = ['1x1', '1x2', '1x3', '1x4', '2x1', '2x2', '2x3', '2x4', '3x1', '3x2', '3x3', '3x4', '4x1', '4x2', '4x3', '4x4'];
const DEFAULT_WIDGET_CONFIG = '[]';
// Grenzen der Widget-Optionen (#814). Sie beschreiben die SPEICHERFORM, nicht
// die Bedeutung: welche Optionen ein Widget kennt, weiss allein das Frontend.
const WIDGET_OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_WIDGET_OPTION_KEYS = 8;
const MAX_WIDGET_OPTION_VALUES = 50;
const MAX_WIDGET_OPTION_LENGTH = 64;

// Welche Quickstart-Vorlagen der Schichtplan-Schnellstart anbietet
// (public/pages/schedule.js#PRESET_TEMPLATES) - haushaltweit und admin-only
// wie disabled_modules, nicht pro Nutzer wie hidden_modules: die Vorlagen
// legen geteilte Schichtarten an, dieselbe Reichweite gilt fuer die Frage,
// welche Knoepfe dafuer sichtbar sind. Ein Haushalt, der nur Arbeit braucht,
// soll nicht dauerhaft Schule/Uni-Knoepfe sehen (Nutzerwunsch).
const SCHEDULE_TEMPLATE_KEYS = ['work', 'school', 'university'];

// Modul-Slugs, die per Settings deaktiviert werden können.
// Dashboard und Settings sind absichtlich nicht enthalten — sie sind essentiell.
const TOGGLEABLE_MODULES = [
  'tasks', 'calendar', 'meals', 'recipes', 'shopping', 'pantry', 'inventory',
  'birthdays', 'notes', 'contacts', 'budget', 'documents',
  'housekeeping', 'rewards', 'health', 'schedule',
];
const MODULE_ORDER_RE = /^(dashboard|tasks|calendar|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|rewards|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const MOBILE_NAV_ORDER_RE = /^(tasks|calendar|kitchen|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|rewards|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const KITCHEN_NAV_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping', 'pantry']);

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDelete(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function userCfgKey(key, userId) {
  return `${key}:user:${Number(userId)}`;
}

function cfgUserGet(key, userId) {
  if (!userId) return null;
  return cfgGet(userCfgKey(key, userId));
}

function cfgUserSet(key, userId, value) {
  if (!userId) return;
  cfgSet(userCfgKey(key, userId), value);
}
// Den eigenen Wert LOESCHEN heisst "ich folge wieder dem Haushalt" - und das
// bleibt es auch nach der naechsten Aenderung des Admins. Den Haushaltswert
// stattdessen zu KOPIEREN waere die naheliegende und die falsche Variante: sie
// friert den heutigen Stand auf dem Konto ein, und der Folger driftet ab der
// ersten spaeteren Aenderung still davon weg (#827).
function cfgUserDelete(key, userId) {
  if (!userId) return;
  cfgDelete(userCfgKey(key, userId));
}

// Drei Sichten auf den Zyklus-Tab (#760), nach demselben Muster wie `language`:
// was der Haushalt erlaubt, was ich für mich gewählt habe, und was am Ende gilt.
//
// Der Admin-Schalter ist der Haushalts-Default; das persönliche Opt-out kann ihn
// nur enger machen, nie weiter. Deshalb UND statt Override: wer den Zyklus
// haushaltweit abschaltet, blendet ihn für alle aus, und niemand holt ihn sich
// einzeln zurück. Fehlender Wert = an, damit Bestandskonten ihr Verhalten behalten.
export function healthCycleViews(userId) {
  const household = cfgGet('health_cycle_enabled') !== '0';
  const personal = cfgUserGet('health_cycle_enabled', userId) !== '0';
  return {
    health_cycle_enabled: household,
    health_cycle_enabled_user: personal,
    health_cycle_effective: household && personal,
  };
}

// Die persönliche Übersicht (#585): eigene Anordnung, sonst die des Haushalts.
//
// EINE Funktion, weil es drei Leser gibt - GET, die PUT-Antwort und künftige.
// Der Fallback stand beim Umbau erst nur im GET; die PUT-Antwort las weiter den
// Haushaltswert und meldete damit nach dem Speichern den Stand zurück, den man
// gerade ersetzt hatte. Zwei Ausdrücke für dieselbe Regel sind einer zu viel.
/**
 * Drei Fragen, drei Sichten - dasselbe Muster wie bei Sprache und Zeitzone:
 * was gilt fuer mich, was hat der Haushalt als Vorgabe hinterlegt, und folge
 * ich ihr ueberhaupt noch.
 *
 * DIE VORGABE HAT EINEN EIGENEN SCHLUESSEL (#827). Der alte haushaltweite
 * `dashboard_widgets` ist ein Fossil aus der Zeit vor #585: er traegt, was
 * zuletzt irgendjemand gespeichert hat, nicht das, was ein Admin als Vorgabe
 * gewaehlt haette. Ihn zu ueberschreiben hiesse, einen Zufallsstand zur
 * bewussten Entscheidung zu erklaeren - und die Oberflaeche koennte "noch keine
 * Vorgabe gesetzt" nicht mehr von "so soll es sein" unterscheiden. Er bleibt
 * deshalb stehen und wirkt als letzte Stufe der Kette, damit Bestandshaushalte
 * ihre gewohnte Anordnung behalten.
 *
 * Ein ZWEITER Grund fuer den eigenen Schluessel steht in test-settings-admin-gate.js:
 * ein Schluessel, der sowohl per `cfgSet` als auch per `cfgUserSet` geschrieben
 * wird, ist fuer diesen Guard nicht mehr entscheidbar (`ambiguous`), und dessen
 * Grenze ist mit Wetter und Zyklus-Schalter bereits ausgeschoepft.
 */
function dashboardDefaults() {
  return {
    widgets: cfgGet('dashboard_widgets_default') ?? cfgGet('dashboard_widgets'),
    glance: cfgGet('dashboard_today_glance_default') ?? cfgGet('dashboard_today_glance'),
  };
}

function sanitizeNoteCategoryOptions(config, visibleCategories) {
  return config.map((widget) => {
    if (widget.id !== 'notes' || !Array.isArray(widget.options?.categories)) return widget;
    const categories = widget.options.categories.filter((id) => visibleCategories().has(String(id)));
    const options = { ...widget.options };
    if (categories.length) options.categories = categories;
    else delete options.categories;
    const next = { ...widget };
    if (Object.keys(options).length) next.options = options;
    else delete next.options;
    return next;
  });
}

function dashboardPersonalViews(userId) {
  const ownWidgets = cfgUserGet('dashboard_widgets', userId);
  const ownGlance = cfgUserGet('dashboard_today_glance', userId);
  const fallback = dashboardDefaults();
  // Request-local and lazy: no catalog query for absent/empty filters, and one
  // shared visibility snapshot for the personal view and household defaults.
  let visible;
  const visibleCategories = () => (visible ??= new Set(
    listVisibleCategories(db.get(), userId).map((category) => String(category.id)),
  ));
  return {
    dashboard_widgets: sanitizeNoteCategoryOptions(parseWidgetConfig(ownWidgets ?? fallback.widgets), visibleCategories),
    dashboard_today_glance: (ownGlance ?? fallback.glance) !== '0',
    // Die Vorgabe des Haushalts, damit die Oberflaeche zeigen kann, wohin ein
    // Zuruecksetzen fuehrt. `null` heisst: es gibt keine.
    dashboard_widgets_default: cfgGet('dashboard_widgets_default') === null
      ? null
      : sanitizeNoteCategoryOptions(parseWidgetConfig(cfgGet('dashboard_widgets_default')), visibleCategories),
    dashboard_today_glance_default: (cfgGet('dashboard_today_glance_default') ?? '1') !== '0',
    // Folge ich der Vorgabe? Nur wer NICHTS Eigenes hinterlegt hat, tut das -
    // und nur fuer den hat "zuruecksetzen" nichts zu tun.
    dashboard_follows_default: ownWidgets === null && ownGlance === null,
  };
}

// Per-User-Wetter-Override lesen (null je Feld = erbt Haushalt).
function weatherUserOverride(userId) {
  const autoRaw = cfgUserGet('weather_auto_locate', userId);
  return {
    lat:   cfgUserGet('weather_lat', userId),
    lon:   cfgUserGet('weather_lon', userId),
    city:  cfgUserGet('weather_city', userId),
    units: cfgUserGet('weather_units', userId),
    auto_locate: autoRaw === null ? null : autoRaw === '1',
  };
}

// --------------------------------------------------------
// Widget-Hilfsfunktionen
// --------------------------------------------------------

function parseWidgetConfig(raw) {
  try {
    const parsed = JSON.parse(raw ?? DEFAULT_WIDGET_CONFIG);
    return normalizeWidgetConfig(parsed) ?? [];
  } catch {
    return JSON.parse(DEFAULT_WIDGET_CONFIG);
  }
}

function parseDisabledModules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
  } catch {
    return [];
  }
}

// ZWEI VERSCHIEDENE FRAGEN AN DIESELBE MODULLISTE (#673).
//
// `disabled_modules` (haushaltweit, Admin) heisst: dieses Modul gibt es hier
// nicht - es verschwindet aus der Navigation UND der Routen-Guard schickt jeden
// zurueck aufs Dashboard. `hidden_modules` (pro Nutzer, kein Admin-Check) heisst:
// ich brauche es nicht auf meinem Bildschirm. Es raeumt die Navigation auf und
// nimmt NICHTS weg: ein Deep-Link aus einer Benachrichtigung oder ein Sprung aus
// einem Dashboard-Widget oeffnet die Seite weiter. Wer wirklich etwas entziehen
// will, hat dafuer die Rechte in `member_permissions` - Verstecken ist Aufraeumen,
// kein Entzug, und die beiden duerfen nicht zu einer Mechanik verschmelzen.
//
// Dieselbe Allowlist wie beim Haushalts-Schalter: Uebersicht und Einstellungen
// sind auch persoenlich nicht wegblendbar, sonst versteckt sich jemand den Weg
// zurueck zu genau diesem Schalter.
function parseHiddenModules(raw) {
  return parseDisabledModules(raw);
}

function parseScheduleHiddenTemplates(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key));
  } catch {
    return [];
  }
}

function parseModuleOrder(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
  } catch {
    return [];
  }
}

function normalizeMobileNavOrder(order) {
  const normalized = [];

  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || !MOBILE_NAV_ORDER_RE.test(id)) continue;
    const normalizedId = KITCHEN_NAV_IDS.has(id) ? 'kitchen' : id;
    if (!normalized.includes(normalizedId)) normalized.push(normalizedId);
    if (normalized.length === 3) break;
  }

  return normalized;
}

function parseMobileNavOrder(raw) {
  if (!raw) return [];
  try {
    return normalizeMobileNavOrder(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Die Optionen eines Widgets - der Server prüft ihre FORM und sonst nichts (#814).
 *
 * Widget-Ids gehören seit jeher dem Frontend: ein neues Widget kostet keine
 * Backend-Änderung, weil hier keine Registry steht, die es kennen müsste. Für
 * die Optionen gilt dasselbe, und aus demselben Grund - eine serverseitige
 * Liste „welches Widget kennt welche Option" wäre der billige Anfang und
 * danach der Preis jedes weiteren Widgets. Was der Server verhindern muss, ist
 * nur, dass hier unbegrenzt viel Fremdinhalt in `sync_config` landet.
 *
 * Erlaubt sind Boolean, endliche Zahlen, kurze Strings und Listen kurzer
 * Strings. Verschachtelte Objekte nicht: sie hätten keine Tiefengrenze, und
 * kein Widget braucht sie.
 *
 * @returns {object|null} normalisierte Optionen, oder null wenn die Form nicht stimmt
 */
function normalizeWidgetOptions(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length > MAX_WIDGET_OPTION_KEYS) return null;

  const out = {};
  for (const key of keys) {
    if (!WIDGET_OPTION_KEY_RE.test(key)) return null;
    const value = input[key];
    if (typeof value === 'boolean') { out[key] = value; continue; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      out[key] = value; continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_WIDGET_OPTION_LENGTH) return null;
      out[key] = value; continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_WIDGET_OPTION_VALUES) return null;
      if (!value.every((v) => typeof v === 'string' && v.length <= MAX_WIDGET_OPTION_LENGTH)) return null;
      out[key] = [...value];
      continue;
    }
    return null;
  }
  return out;
}

function normalizeWidgetConfig(input) {
  if (!Array.isArray(input) || input.length > MAX_DASHBOARD_WIDGETS) return null;

  const seenIds = new Set();
  const normalized = [];
  for (const [index, widget] of input.entries()) {
    if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return null;
    if (!isWidgetId(widget.id) || seenIds.has(widget.id)) return null;
    if (widget.visible !== undefined && typeof widget.visible !== 'boolean') return null;
    if (widget.order !== undefined && !Number.isFinite(Number(widget.order))) return null;
    if (widget.size !== undefined && !VALID_WIDGET_SIZES.includes(widget.size)) return null;
    const options = normalizeWidgetOptions(widget.options);
    if (options === null) return null;

    seenIds.add(widget.id);
    normalized.push({
      id: widget.id,
      visible: widget.visible !== false,
      order: widget.order === undefined ? index : Number(widget.order),
      size: widget.size ?? '1x1',
      // Ein leeres Optionsobjekt wird nicht mitgeschleppt: es wäre in jedem
      // gespeicherten Layout dieselbe leere Klammer und in jeder Antwort ein
      // Feld, das nichts sagt.
      ...(Object.keys(options).length ? { options } : {}),
    });
  }

  return normalized
    .sort((a, b) => a.order - b.order)
    .map((widget, order) => ({ ...widget, order }));
}

// --------------------------------------------------------
// GET /api/v1/preferences
// Alle Haushalt-Praeferenzen lesen.
// Response: { data: { visible_meal_types: string[] } }
// --------------------------------------------------------

router.get('/', (req, res) => {
  try {
    const raw = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const visibleMealTypes = raw.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const mealTypeNames = parseMealTypeNames(cfgGet('meal_type_names'));
    const currency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const dateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const timeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const weekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const appName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const disabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const hiddenModules = parseHiddenModules(cfgUserGet('hidden_modules', req.authUserId));
    const moduleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const mobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));

    res.json({
      data: {
        visible_meal_types: visibleMealTypes,
        meal_type_names: mealTypeNames,
        currency,
        date_format: dateFormat,
        time_format: timeFormat,
        week_start: weekStart,
        region: cfgGet('region') || null,
        // Zwei Sichten wie bei der Sprache: was ist gewählt (Select-Zustand) und
        // was gilt gerade. `timezone_effective` ist nie leer - ohne Einstellung
        // steht dort die Zone, auf die der Server zurückfällt, und genau die
        // muss die Oberfläche als Automatik-Label zeigen können (#829).
        timezone: cfgGet('household_timezone') || null,
        timezone_effective: householdTimeZone(db.get()),
        // Drei Sichten auf dieselbe Einstellung, weil drei verschiedene Fragen
        // dahinterstecken: was ist gewählt (Select-Zustand), was gilt gerade
        // (API-Konsument), und was ergäbe die Automatik (Label der ersten Option).
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: appName,
        // Anordnung und Kopfband der Übersicht - persönlich, mit Haushalts-Fallback (#585).
        ...dashboardPersonalViews(req.authUserId),
        disabled_modules: disabledModules,
        hidden_modules: hiddenModules,
        module_order: moduleOrder,
        mobile_nav_order: mobileNavOrder,
        housekeeping_payment_tasks: cfgGet('housekeeping_payment_tasks') === '1',
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        // Standardwerte für neue Termine (per-user, #497/#498).
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        // Modul-Feature-Schalter (haushaltweit). Default an: fehlender Wert =>
        // Feature aktiv, damit Bestandshaushalte ihr Verhalten behalten.
        ...healthCycleViews(req.authUserId),
        rewards_require_approval: cfgGet('rewards_require_approval') !== '0',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        tasks_default_points: parseTaskDefaultPoints(cfgGet('tasks_default_points')),
        countdown_grace_days: parseCountdownGraceDays(cfgGet('countdown_grace_days')),
        // Standard-Erinnerungsliste fuer neue Aufgaben (per-user, #695) -
        // dieselbe Form wie calendar_default_target, damit beide Dialoge ihr
        // Ziel gleich benennen.
        tasks_default_target: cfgUserGet('tasks_default_target', req.authUserId) || '',
        schedule_hidden_templates: parseScheduleHiddenTemplates(cfgGet('schedule_hidden_templates')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
      },
    });
  } catch (err) {
    log.error('GET /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/preferences
// Haushalt-Praeferenzen aktualisieren.
// Body: { visible_meal_types: string[] }
// Response: { data: { visible_meal_types: string[] } }
// --------------------------------------------------------

router.put('/', (req, res) => {
  try {
    const { visible_meal_types, meal_type_names, currency, date_format, time_format, week_start, region, timezone, language, app_name, dashboard_widgets, dashboard_today_glance, dashboard_widgets_default, dashboard_today_glance_default, disabled_modules, hidden_modules, module_order, mobile_nav_order, housekeeping_payment_tasks, budget_mode, calendar_default_duration, calendar_default_reminders, calendar_default_assign_me, calendar_default_target, health_cycle_enabled, health_cycle_enabled_user, rewards_require_approval, tasks_subtasks_expanded, tasks_default_points, tasks_default_target, schedule_hidden_templates, countdown_grace_days, weather_provider, weather_lat, weather_lon, weather_city, weather_units, weather_auto_locate, weather_user, holiday_country, holiday_subdivision, holiday_group, holiday_show_public, holiday_show_school, holiday_public_color, holiday_school_color } = req.body;

    if (visible_meal_types !== undefined) {
      if (!Array.isArray(visible_meal_types)) {
        return res.status(400).json({ error: 'visible_meal_types muss ein Array sein', code: 400 });
      }
      const filtered = visible_meal_types.filter((t) => VALID_MEAL_TYPES.includes(t));
      if (filtered.length === 0) {
        return res.status(400).json({ error: 'Mindestens ein Mahlzeit-Typ muss aktiv sein', code: 400 });
      }
      cfgSet('visible_meal_types', filtered.join(','));
    }

    if (meal_type_names !== undefined) {
      if (meal_type_names === null) {
        cfgSet('meal_type_names', '');
      } else if (typeof meal_type_names !== 'object' || Array.isArray(meal_type_names)) {
        return res.status(400).json({ error: 'meal_type_names muss ein Objekt sein', code: 400 });
      } else {
        // Jeder gesendete Wert muss ein String sein - eine Zahl oder ein
        // verschachteltes Objekt waere ein Aufruffehler und soll nicht still
        // als leerer Name durchgehen. Welche SLOTS gelten, entscheidet dagegen
        // die Allowlist in parseMealTypeNames(): ein unbekannter Slot ist kein
        // Fehler des Aufrufers, sondern nichts, was wir speichern.
        for (const [slot, value] of Object.entries(meal_type_names)) {
          if (value !== null && typeof value !== 'string') {
            return res.status(400).json({ error: `meal_type_names.${slot} muss ein String sein`, code: 400 });
          }
          if (typeof value === 'string' && value.trim().length > MAX_MEAL_TYPE_NAME) {
            return res.status(400).json({ error: `meal_type_names.${slot}: maximal ${MAX_MEAL_TYPE_NAME} Zeichen`, code: 400 });
          }
        }
        // Ueber parseMealTypeNames normalisiert speichern (getrimmt, leere
        // Namen fallen raus): so steht in der Zeile genau das, was der
        // Lesepfad ohnehin daraus machen wuerde, und ein leeres Objekt ist die
        // Rueckkehr zu den eingebauten Woertern.
        const names = parseMealTypeNames(JSON.stringify(meal_type_names));
        cfgSet('meal_type_names', Object.keys(names).length ? JSON.stringify(names) : '');
      }
    }

    if (currency !== undefined) {
      if (!CURRENCY_CODES.includes(currency)) {
        return res.status(400).json({ error: `Ungültige Währung. Erlaubt: ${CURRENCY_CODES.join(', ')}`, code: 400 });
      }
      cfgSet('currency', currency);
    }

    if (date_format !== undefined) {
      if (!VALID_DATE_FORMATS.includes(date_format)) {
        return res.status(400).json({ error: `Ungültiges Datumsformat. Erlaubt: ${VALID_DATE_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('date_format', date_format);
    }

    if (time_format !== undefined) {
      if (!VALID_TIME_FORMATS.includes(time_format)) {
        return res.status(400).json({ error: `Invalid time format. Allowed: ${VALID_TIME_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('time_format', time_format);
    }

    // Wochenstart — haushaltweit, von jedem Mitglied änderbar (wie date/time_format).
    if (week_start !== undefined) {
      if (!VALID_WEEK_STARTS.includes(week_start)) {
        return res.status(400).json({ error: `Ungültiger Wochenstart. Erlaubt: ${VALID_WEEK_STARTS.join(', ')}`, code: 400 });
      }
      cfgSet('week_start', week_start);
    }

    // Budget-Modus — haushaltweite Grundsatzentscheidung, nur Admin (#476/#505).
    if (budget_mode !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!VALID_BUDGET_MODES.includes(budget_mode)) {
        return res.status(400).json({ error: `Ungültiger Budget-Modus. Erlaubt: ${VALID_BUDGET_MODES.join(', ')}`, code: 400 });
      }
      cfgSet('budget_mode', budget_mode);
    }

    // Welche Region-Vorlage der Nutzer gewählt hat. Nötig, weil sich mehrere
    // Regionen dasselbe currency/date/time-Triple teilen und der Dropdown sonst
    // nach dem Speichern auf die falsche Region springt (#486).
    //
    // Seit die Datensprache aus der Region abgeleitet wird, ist das keine reine
    // Anzeige-Hilfe mehr: eine Region schiebt die Sprache, in der Geburtstags-
    // Termine gespeichert werden. Deshalb dasselbe Admin-Gate wie bei `language`
    // - sonst wäre der dortige Schutz über diesen Umweg zu umgehen. Die Oberfläche
    // behandelte die Region ohnehin immer als Admin-Feld, nur die Route nicht.
    if (region !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (region !== null && (typeof region !== 'string' || !VALID_REGION.test(region))) {
        return res.status(400).json({ error: 'Ungültige Region.', code: 400 });
      }
      cfgSet('region', region ?? '');
    }

    // Zeitzone des Haushalts (#829) - dieselbe Sorte Grundsatzentscheidung wie
    // Region und Datensprache, also dasselbe Admin-Gate. null/'' stellt auf
    // "automatisch" zurueck, dann gilt wieder TZ → Systemzone → UTC.
    //
    // Der Wert ist keine Anzeige-Hilfe: an ihm haengen der Kalendertag, den
    // Server-Jobs "heute" nennen, die Zone im ICS-Feed, den fremde Kalender
    // abonnieren, und die Wanduhrzeit, mit der Termine zu Google und Outlook
    // hinausgehen. Ein Mitglied darf ihn deshalb nicht fuer alle umstellen.
    if (timezone !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (timezone !== null && timezone !== '' && !isValidTimeZone(timezone)) {
        return res.status(400).json({
          error: 'Ungültige Zeitzone. Erwartet wird eine IANA-Zone wie "Europe/Berlin".', code: 400,
        });
      }
      if (timezone === null || timezone === '') cfgDelete('household_timezone');
      else cfgSet('household_timezone', timezone);
    }

    // Datensprache — haushaltweite Grundsatzentscheidung wie Region und Währung,
    // deshalb nur Admin. null/'' stellt auf "automatisch" zurück (aus der Region).
    if (language !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (language !== null && language !== '' && !isSupportedLocale(language)) {
        return res.status(400).json({ error: `Ungültige Sprache. Erlaubt: ${VALID_LANGUAGES.join(', ')}`, code: 400 });
      }
      if (language === null || language === '') cfgDelete('language');
      else cfgSet('language', language);
    }

    if (app_name !== undefined) {
      const vAppName = str(app_name, 'Application name', { max: MAX_SHORT, required: false });
      if (vAppName.error) return res.status(400).json({ error: vAppName.error, code: 400 });
      if (vAppName.value) cfgSet('app_name', vAppName.value);
      else cfgDelete('app_name');
    }

    // DIE ÜBERSICHT GEHÖRT DER PERSON, NICHT DEM HAUSHALT (#585).
    //
    // Auswahl, Reihenfolge und Größe der Kacheln lagen haushaltweit: wer das
    // Zyklus-Widget für sich abwählte, nahm es allen weg, und wer sich die
    // Aufgaben nach oben zog, verschob sie auch für die Kinder. Genau daran
    // hing der Wunsch - eine Familie hat auf derselben Seite verschiedene
    // Bedürfnisse. Das Muster dafür steht schon nebenan: `module_order` liest
    // per-user MIT Haushalts-Fallback und schreibt ausschliesslich per-user.
    //
    // KEIN DUAL-WRITE, und das ist eine bewusste Entscheidung, keine Bequemlichkeit.
    // Ein Schlüssel, der beide Wege kennt, ist für test-settings-admin-gate.js
    // nicht mehr entscheidbar (`ambiguous`) - dort kostet jeder solche Schlüssel
    // Reichweite, und die Grenze ist mit Wetter und Zyklus bereits ausgeschöpft.
    // Der alte Haushaltswert bleibt deshalb liegen und wirkt nur noch als
    // Fallback: bestehende Haushalte sehen ihre gewohnte Anordnung weiter, jeder
    // bekommt seine eigene erst in dem Moment, in dem er selbst etwas ändert.
    // Deshalb braucht dieser Schritt auch keine Migration.
    //
    // Das Kopfband „Heute auf einen Blick" (#740) fährt mit, weil es im selben
    // PUT gespeichert wird: bliebe es haushaltweit, schaltete ein persönliches
    // Ausblenden es weiterhin für alle ab - genau der Bruch, den #585 meldet.
    // `null` ist hier kein leeres Layout, sondern der Rueckweg: mein eigener
    // Stand wird geloescht, und damit gilt wieder die Vorgabe des Haushalts -
    // heute und nach jeder spaeteren Aenderung daran (#827).
    if (dashboard_widgets !== undefined) {
      if (dashboard_widgets === null) {
        cfgUserDelete('dashboard_widgets', req.authUserId);
      } else if (!Array.isArray(dashboard_widgets)) {
        return res.status(400).json({ error: 'dashboard_widgets muss ein Array sein', code: 400 });
      } else {
        const normalized = normalizeWidgetConfig(dashboard_widgets);
        if (normalized === null) {
          return res.status(400).json({ error: 'dashboard_widgets enthält ungültige Einträge', code: 400 });
        }
        cfgUserSet('dashboard_widgets', req.authUserId, JSON.stringify(normalized));
      }
    }

    if (dashboard_today_glance !== undefined) {
      if (dashboard_today_glance === null) {
        cfgUserDelete('dashboard_today_glance', req.authUserId);
      } else if (typeof dashboard_today_glance !== 'boolean') {
        return res.status(400).json({ error: 'dashboard_today_glance muss ein Boolean sein', code: 400 });
      } else {
        cfgUserSet('dashboard_today_glance', req.authUserId, dashboard_today_glance ? '1' : '0');
      }
    }

    // DIE VORGABE DES HAUSHALTS (#827). Sie gilt fuer alle, die sich noch keine
    // eigene Uebersicht eingerichtet haben - typischerweise die Mitglieder, die
    // nie in den Anpassen-Modus gehen. Deshalb Admin-Gate wie bei Region,
    // Datensprache und Zeitzone.
    //
    // SIE UEBERSCHREIBT NIEMANDEN. Wer eine eigene Anordnung hat, behaelt sie;
    // ein Haushaltswert, der persoenliche Arrangements plattmacht, ist die
    // Sorte Schalter, die man einmal benutzt und danach bereut. Der Preis dafuer
    // ist der Rueckweg oben - ohne ihn waere die Vorgabe fuer jeden unsichtbar,
    // der je eine Kachel verschoben hat.
    if (dashboard_widgets_default !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (dashboard_widgets_default === null) {
        cfgDelete('dashboard_widgets_default');
      } else if (!Array.isArray(dashboard_widgets_default)) {
        return res.status(400).json({ error: 'dashboard_widgets_default muss ein Array sein', code: 400 });
      } else {
        const normalized = normalizeWidgetConfig(dashboard_widgets_default);
        if (normalized === null) {
          return res.status(400).json({ error: 'dashboard_widgets_default enthält ungültige Einträge', code: 400 });
        }
        cfgSet('dashboard_widgets_default', JSON.stringify(normalized));
      }
    }

    if (dashboard_today_glance_default !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (dashboard_today_glance_default === null) {
        cfgDelete('dashboard_today_glance_default');
      } else if (typeof dashboard_today_glance_default !== 'boolean') {
        return res.status(400).json({ error: 'dashboard_today_glance_default muss ein Boolean sein', code: 400 });
      } else {
        cfgSet('dashboard_today_glance_default', dashboard_today_glance_default ? '1' : '0');
      }
    }

    if (disabled_modules !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!Array.isArray(disabled_modules)) {
        return res.status(400).json({ error: 'disabled_modules muss ein Array sein', code: 400 });
      }
      const filtered = disabled_modules
        .filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
      const unique = [...new Set(filtered)];
      cfgSet('disabled_modules', JSON.stringify(unique));
    }

    // Persoenlich ausgeblendete Module (#673) - bewusst OHNE Admin-Check, das ist
    // der ganze Punkt: bisher konnte nur eine Adminin Module abschalten, und zwar
    // gleich fuer alle. Siehe parseHiddenModules fuer die Abgrenzung zum
    // Haushalts-Schalter darueber.
    if (hidden_modules !== undefined) {
      if (!Array.isArray(hidden_modules)) {
        return res.status(400).json({ error: 'hidden_modules muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(
        hidden_modules.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m)),
      )];
      cfgUserSet('hidden_modules', req.authUserId, JSON.stringify(unique));
    }

    if (module_order !== undefined) {
      if (!Array.isArray(module_order)) {
        return res.status(400).json({ error: 'module_order muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(module_order.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
      cfgUserSet('module_order', req.authUserId, JSON.stringify(unique));
    }

    if (mobile_nav_order !== undefined) {
      if (!Array.isArray(mobile_nav_order)) {
        return res.status(400).json({ error: 'mobile_nav_order muss ein Array sein', code: 400 });
      }
      cfgUserSet(
        'mobile_nav_order',
        req.authUserId,
        JSON.stringify(normalizeMobileNavOrder(mobile_nav_order)),
      );
    }

    if (housekeeping_payment_tasks !== undefined) {
      if (typeof housekeeping_payment_tasks !== 'boolean') {
        return res.status(400).json({ error: 'housekeeping_payment_tasks must be a boolean', code: 400 });
      }
      cfgSet('housekeeping_payment_tasks', housekeeping_payment_tasks ? '1' : '0');
    }

    if (calendar_default_duration !== undefined) {
      const minutes = Number(calendar_default_duration);
      if (!Number.isInteger(minutes) || minutes < MIN_CALENDAR_DURATION || minutes > MAX_CALENDAR_DURATION) {
        return res.status(400).json({ error: `calendar_default_duration must be an integer between ${MIN_CALENDAR_DURATION} and ${MAX_CALENDAR_DURATION}`, code: 400 });
      }
      cfgSet('calendar_default_duration', String(minutes));
    }

    // Standard-Erinnerungen für neue Termine (#497, per-user).
    if (calendar_default_reminders !== undefined) {
      if (!Array.isArray(calendar_default_reminders)) {
        return res.status(400).json({ error: 'calendar_default_reminders muss ein Array sein', code: 400 });
      }
      const nums = calendar_default_reminders.map(Number);
      if (nums.some((n) => !VALID_REMINDER_OFFSETS.includes(n))) {
        return res.status(400).json({ error: `calendar_default_reminders: erlaubte Offsets (Minuten): ${VALID_REMINDER_OFFSETS.join(', ')}`, code: 400 });
      }
      const unique = [...new Set(nums)].sort((a, b) => a - b);
      if (unique.length > MAX_DEFAULT_REMINDERS) {
        return res.status(400).json({ error: `Maximal ${MAX_DEFAULT_REMINDERS} Standard-Erinnerungen.`, code: 400 });
      }
      cfgUserSet('calendar_default_reminders', req.authUserId, JSON.stringify(unique));
    }

    // Neue Termine standardmäßig mir zuweisen (#498, per-user).
    if (calendar_default_assign_me !== undefined) {
      cfgUserSet('calendar_default_assign_me', req.authUserId, calendar_default_assign_me ? '1' : '0');
    }

    // Standard-Sync-Ziel für eigene neue Termine (#620, per-user).
    if (calendar_default_target !== undefined) {
      if (calendar_default_target !== null && typeof calendar_default_target !== 'string') {
        return res.status(400).json({ error: 'calendar_default_target muss ein String sein', code: 400 });
      }
      const target = (calendar_default_target ?? '').trim();
      if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
        return res.status(400).json({ error: `calendar_default_target: maximal ${MAX_CALENDAR_TARGET_LENGTH} Zeichen`, code: 400 });
      }
      // Leer = "Lokal speichern" und damit das ausdrückliche Abwählen eines
      // zuvor gesetzten Ziels. parseSyncTargetValue liefert dafür {kind:'local'},
      // also einen gültigen Wert, und null nur bei echtem Formfehler.
      if (parseSyncTargetValue(target) === null) {
        return res.status(400).json({ error: 'calendar_default_target: erwartet "google:<id>", "caldav:<kontoId>|<url>" oder "outlook:<kontoId>|<kalenderId>"', code: 400 });
      }
      cfgUserSet('calendar_default_target', req.authUserId, target);
    }

    // Standard-Erinnerungsliste für eigene neue Aufgaben (#695, per-user).
    // Geprüft wird nur die Form; ob die Liste noch freigegeben ist, entscheidet
    // die Aufgaben-Route beim Anlegen. Ein Ziel hier hart abzuweisen, weil eine
    // Liste zwischenzeitlich abgewählt wurde, machte die Einstellung unspeicherbar,
    // ohne dass der Grund an dieser Stelle sichtbar wäre.
    if (tasks_default_target !== undefined) {
      if (tasks_default_target !== null && typeof tasks_default_target !== 'string') {
        return res.status(400).json({ error: 'tasks_default_target muss ein String sein', code: 400 });
      }
      const target = (tasks_default_target ?? '').trim();
      if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
        return res.status(400).json({ error: `tasks_default_target: maximal ${MAX_CALENDAR_TARGET_LENGTH} Zeichen`, code: 400 });
      }
      const parsed = parseSyncTargetValue(target);
      if (parsed === null || parsed.kind === 'google') {
        return res.status(400).json({ error: 'tasks_default_target: erwartet "caldav:<kontoId>|<url>"', code: 400 });
      }
      cfgUserSet('tasks_default_target', req.authUserId, target);
    }

    // Welche Quickstart-Vorlagen der Schichtplan-Schnellstart zeigt - wie
    // disabled_modules haushaltweit und admin-only, nicht wie hidden_modules
    // pro Nutzer: die Vorlagen legen geteilte Schichtarten an.
    if (schedule_hidden_templates !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!Array.isArray(schedule_hidden_templates)) {
        return res.status(400).json({ error: 'schedule_hidden_templates muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(
        schedule_hidden_templates.filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key)),
      )];
      cfgSet('schedule_hidden_templates', JSON.stringify(unique));
    }

    // Haushaltweite Modul-Feature-Schalter — nur Admins.
    if (health_cycle_enabled !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof health_cycle_enabled !== 'boolean') {
        return res.status(400).json({ error: 'health_cycle_enabled must be a boolean', code: 400 });
      }
      cfgSet('health_cycle_enabled', health_cycle_enabled ? '1' : '0');
    }

    // Persönliches Opt-out (#760) - bewusst OHNE Admin-Gate: es betrifft nur die
    // eigene Ansicht, und derselbe Fehler (per-user-Wert hinter adminOnly) kostete
    // schon einmal fünf von sechs Familienmitgliedern ihre Einstellung
    // (Critique 2026-07-27, siehe calendar_default_reminders).
    if (health_cycle_enabled_user !== undefined) {
      if (typeof health_cycle_enabled_user !== 'boolean') {
        return res.status(400).json({ error: 'health_cycle_enabled_user must be a boolean', code: 400 });
      }
      cfgUserSet('health_cycle_enabled', req.authUserId, health_cycle_enabled_user ? '1' : '0');
    }

    if (rewards_require_approval !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof rewards_require_approval !== 'boolean') {
        return res.status(400).json({ error: 'rewards_require_approval must be a boolean', code: 400 });
      }
      cfgSet('rewards_require_approval', rewards_require_approval ? '1' : '0');
    }

    if (tasks_subtasks_expanded !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof tasks_subtasks_expanded !== 'boolean') {
        return res.status(400).json({ error: 'tasks_subtasks_expanded must be a boolean', code: 400 });
      }
      cfgSet('tasks_subtasks_expanded', tasks_subtasks_expanded ? '1' : '0');
    }

    // Standard-Punktwert für neue Aufgaben (#578). 0 schaltet den Standard ab.
    if (tasks_default_points !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      const points = Number(tasks_default_points);
      if (!Number.isInteger(points) || points < 0 || points > MAX_TASK_POINTS) {
        return res.status(400).json({ error: `tasks_default_points must be an integer between 0 and ${MAX_TASK_POINTS}`, code: 400 });
      }
      cfgSet('tasks_default_points', String(points));
    }

    // Nachfrist für abgelaufene Countdowns (#969). 0 = keine Nachfrist.
    if (countdown_grace_days !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      const days = Number(countdown_grace_days);
      if (!Number.isInteger(days) || days < 0 || days > MAX_COUNTDOWN_GRACE_DAYS) {
        return res.status(400).json({ error: `countdown_grace_days must be an integer between 0 and ${MAX_COUNTDOWN_GRACE_DAYS}`, code: 400 });
      }
      cfgSet('countdown_grace_days', String(days));
    }

    // Weather configuration — admin only
    if (
      weather_provider !== undefined ||
      weather_lat      !== undefined ||
      weather_lon      !== undefined ||
      weather_city     !== undefined ||
      weather_units    !== undefined ||
      weather_auto_locate !== undefined
    ) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (weather_provider !== undefined) {
        if (weather_provider !== null && !VALID_WEATHER_PROVIDERS.includes(weather_provider)) {
          return res.status(400).json({ error: `Ungültiger Anbieter. Erlaubt: ${VALID_WEATHER_PROVIDERS.join(', ')}`, code: 400 });
        }
        if (weather_provider === null) cfgDelete('weather_provider');
        else cfgSet('weather_provider', weather_provider);
      }
      if (weather_lat !== undefined) {
        const v = parseFloat(weather_lat);
        if (isNaN(v) || v < -90 || v > 90) {
          return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
        }
        cfgSet('weather_lat', String(v));
      }
      if (weather_lon !== undefined) {
        const v = parseFloat(weather_lon);
        if (isNaN(v) || v < -180 || v > 180) {
          return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
        }
        cfgSet('weather_lon', String(v));
      }
      if (weather_city !== undefined) {
        const trimmed = String(weather_city).slice(0, 100).trim();
        if (trimmed) cfgSet('weather_city', trimmed);
        else cfgDelete('weather_city');
      }
      if (weather_units !== undefined) {
        if (!VALID_WEATHER_UNITS.includes(weather_units)) {
          return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
        }
        cfgSet('weather_units', weather_units);
      }
      if (weather_auto_locate !== undefined) {
        if (typeof weather_auto_locate !== 'boolean') {
          return res.status(400).json({ error: 'weather_auto_locate muss ein Boolean sein.', code: 400 });
        }
        cfgSet('weather_auto_locate', weather_auto_locate ? '1' : '0');
      }
    }

    // Per-User-Wetter-Override — von jedem authentifizierten Nutzer schreibbar.
    if (weather_user !== undefined) {
      if (typeof weather_user !== 'object' || weather_user === null || Array.isArray(weather_user)) {
        return res.status(400).json({ error: 'weather_user muss ein Objekt sein.', code: 400 });
      }
      const uid = req.authUserId;
      if (!uid) {
        return res.status(401).json({ error: 'Authentifizierung erforderlich.', code: 401 });
      }
      const { lat, lon, city, units, auto_locate } = weather_user;

      if (lat !== undefined) {
        if (lat === null) cfgDelete(userCfgKey('weather_lat', uid));
        else {
          const v = parseFloat(lat);
          if (isNaN(v) || v < -90 || v > 90) {
            return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
          }
          cfgUserSet('weather_lat', uid, String(v));
        }
      }
      if (lon !== undefined) {
        if (lon === null) cfgDelete(userCfgKey('weather_lon', uid));
        else {
          const v = parseFloat(lon);
          if (isNaN(v) || v < -180 || v > 180) {
            return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
          }
          cfgUserSet('weather_lon', uid, String(v));
        }
      }
      if (city !== undefined) {
        const trimmed = city === null ? '' : String(city).slice(0, 100).trim();
        if (trimmed) cfgUserSet('weather_city', uid, trimmed);
        else cfgDelete(userCfgKey('weather_city', uid));
      }
      if (units !== undefined) {
        if (units === null) cfgDelete(userCfgKey('weather_units', uid));
        else {
          if (!VALID_WEATHER_UNITS.includes(units)) {
            return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
          }
          cfgUserSet('weather_units', uid, units);
        }
      }
      if (auto_locate !== undefined) {
        if (auto_locate === null) cfgDelete(userCfgKey('weather_auto_locate', uid));
        else {
          if (typeof auto_locate !== 'boolean') {
            return res.status(400).json({ error: 'weather_user.auto_locate muss ein Boolean sein.', code: 400 });
          }
          cfgUserSet('weather_auto_locate', uid, auto_locate ? '1' : '0');
        }
      }
    }

    // Holiday configuration — admin only
    if (
      holiday_country      !== undefined ||
      holiday_subdivision  !== undefined ||
      holiday_group        !== undefined ||
      holiday_show_public  !== undefined ||
      holiday_show_school  !== undefined ||
      holiday_public_color !== undefined ||
      holiday_school_color !== undefined
    ) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (holiday_country !== undefined) {
        if (holiday_country !== null && !COUNTRY_ISO_RE.test(holiday_country)) {
          return res.status(400).json({ error: 'Ungültiger Ländercode (2 Großbuchstaben, z. B. DE).', code: 400 });
        }
        if (holiday_country === null) {
          cfgDelete('holiday_country');
          cfgDelete('holiday_subdivision');
          cfgDelete('holiday_group');
        } else {
          cfgSet('holiday_country', holiday_country);
        }
      }
      if (holiday_subdivision !== undefined) {
        if (holiday_subdivision !== null && !SUBDIVISION_RE.test(holiday_subdivision)) {
          return res.status(400).json({ error: 'Ungültiger Regionscode (z. B. DE-BY).', code: 400 });
        }
        // Ohne Subdivision gibt es keine Schulferien-Gruppe mehr → mit aufräumen.
        if (holiday_subdivision === null) {
          cfgDelete('holiday_subdivision');
          cfgDelete('holiday_group');
        } else {
          cfgSet('holiday_subdivision', holiday_subdivision);
        }
      }
      // Schulferien-Gruppe (z. B. CH-BE-VS) mehrsprachiger Kantone. Nutzt dieselbe
      // Grammatik wie ein Regionscode. NULL/leer = keine Gruppe gewählt. (#434)
      if (holiday_group !== undefined) {
        if (holiday_group !== null && holiday_group !== '' && !SUBDIVISION_RE.test(holiday_group)) {
          return res.status(400).json({ error: 'Ungültiger Gruppencode (z. B. CH-BE-VS).', code: 400 });
        }
        if (holiday_group === null || holiday_group === '') cfgDelete('holiday_group');
        else cfgSet('holiday_group', holiday_group);
      }
      if (holiday_show_public !== undefined) {
        if (typeof holiday_show_public !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_public must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_public', holiday_show_public ? '1' : '0');
      }
      if (holiday_show_school !== undefined) {
        if (typeof holiday_show_school !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_school must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_school', holiday_show_school ? '1' : '0');
      }
      if (holiday_public_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_public_color)) {
          return res.status(400).json({ error: 'holiday_public_color muss ein gültiger Hex-Farbwert sein (z. B. #FF3B30).', code: 400 });
        }
        cfgSet('holiday_public_color', holiday_public_color);
      }
      if (holiday_school_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_school_color)) {
          return res.status(400).json({ error: 'holiday_school_color muss ein gültiger Hex-Farbwert sein (z. B. #34C759).', code: 400 });
        }
        cfgSet('holiday_school_color', holiday_school_color);
      }
    }

    const rawMealTypes = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const savedMealTypes = rawMealTypes.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const savedCurrency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const savedDateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const savedTimeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const savedWeekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const savedAppName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const savedDisabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const savedHiddenModules = parseHiddenModules(cfgUserGet('hidden_modules', req.authUserId));
    const savedModuleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const savedMobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));
    const savedHousekeepingPaymentTasks = cfgGet('housekeeping_payment_tasks') === '1';
    // AUS DER DATENBANK ZURUECKLESEN, nicht aus dem Request: der Client sieht so
    // genau das, was gespeichert wurde - getrimmt, gekappt, unbekannte Slots
    // schon aussortiert - statt seiner eigenen Eingabe.
    const savedMealTypeNames = parseMealTypeNames(cfgGet('meal_type_names'));

    res.json({
      data: {
        visible_meal_types: savedMealTypes,
        meal_type_names: savedMealTypeNames,
        currency: savedCurrency,
        date_format: savedDateFormat,
        time_format: savedTimeFormat,
        week_start: savedWeekStart,
        region: cfgGet('region') || null,
        timezone: cfgGet('household_timezone') || null,
        timezone_effective: householdTimeZone(db.get()),
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: savedAppName,
        ...dashboardPersonalViews(req.authUserId),
        disabled_modules: savedDisabledModules,
        hidden_modules: savedHiddenModules,
        module_order: savedModuleOrder,
        mobile_nav_order: savedMobileNavOrder,
        housekeeping_payment_tasks: savedHousekeepingPaymentTasks,
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        ...healthCycleViews(req.authUserId),
        rewards_require_approval: cfgGet('rewards_require_approval') !== '0',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        tasks_default_points: parseTaskDefaultPoints(cfgGet('tasks_default_points')),
        countdown_grace_days: parseCountdownGraceDays(cfgGet('countdown_grace_days')),
        // Standard-Erinnerungsliste fuer neue Aufgaben (per-user, #695) -
        // dieselbe Form wie calendar_default_target, damit beide Dialoge ihr
        // Ziel gleich benennen.
        tasks_default_target: cfgUserGet('tasks_default_target', req.authUserId) || '',
        schedule_hidden_templates: parseScheduleHiddenTemplates(cfgGet('schedule_hidden_templates')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
      },
    });
  } catch (err) {
    log.error('PUT /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  } finally {
    // Gespeicherte Geburtstags-Termine an die geltende Datensprache angleichen.
    //
    // Unbedingt statt nur bei erkannter Verschiebung: retitleBirthdayEvents
    // vergleicht ohnehin pro Zeile und schreibt nur, was abweicht. Ein Vergleich
    // vorher/nachher wäre ein zweiter Ort, an dem alle Wege zur Datensprache
    // (language, region, date_format) vollständig aufgezählt sein müssten.
    //
    // Im finally, weil der Handler schreibt und validiert, während er durch die
    // Felder läuft: ein Batch aus gültiger `language` und einem später
    // abgelehnten Feld verlässt ihn über ein `return res.status(400)`, hat die
    // Sprache aber schon geschrieben. Am Ende des try-Blocks bliebe der Haushalt
    // dann auf einer neuen Sprache mit alten Titeln sitzen.
    //
    // Fehler beenden die Anfrage nicht: die Antwort ist zu diesem Zeitpunkt
    // längst gesendet, und die Präferenzen sind geschrieben. Der nächste PUT
    // versucht es erneut - der Lauf ist idempotent.
    try {
      db.transaction(() => retitleBirthdayEvents(db.get()));
    } catch (err) {
      log.error('PUT / - Geburtstags-Termine konnten nicht umbenannt werden', err);
    }
  }
});

// GET /api/v1/preferences/holidays/countries
router.get('/holidays/countries', async (_req, res) => {
  try {
    const countries = await holidays.getCountries();
    res.json({ data: countries });
  } catch (err) {
    log.error('GET /holidays/countries', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Länderliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/subdivisions/:countryCode
router.get('/holidays/subdivisions/:countryCode', async (req, res) => {
  const { countryCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  try {
    const subdivisions = await holidays.getSubdivisions(countryCode);
    res.json({ data: subdivisions });
  } catch (err) {
    log.error('GET /holidays/subdivisions/:countryCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Regionsliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode/:subdivisionCode
// Schulferien-Gruppen einer Subdivision (mehrsprachige Kantone). Leere Liste,
// wenn die Subdivision nur ein Ferien-Regime kennt. (#434)
router.get('/holidays/groups/:countryCode/:subdivisionCode', async (req, res) => {
  const { countryCode, subdivisionCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  if (!SUBDIVISION_RE.test(subdivisionCode)) {
    return res.status(400).json({ error: 'Ungültiger Regionscode.', code: 400 });
  }
  try {
    const groups = await holidays.getGroups(countryCode, subdivisionCode);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode/:subdivisionCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Ferien-Gruppen.', code: 502 });
  }
});

// POST /api/v1/preferences/holidays/sync  (admin only)
router.post('/holidays/sync', async (req, res) => {
  if (req.authRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.', code: 403 });
  }
  try {
    await holidays.sync(true);
    res.json({ data: { last_sync: cfgGet('holiday_last_sync') ?? null } });
  } catch (err) {
    log.error('POST /holidays/sync', err);
    res.status(502).json({ error: 'Fehler bei der Feiertags-Synchronisierung: ' + err.message, code: 502 });
  }
});

export default router;
